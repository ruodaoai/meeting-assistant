#!/usr/bin/env node
/**
 * Ruodao 会议助手（AI 参会 · 实时转写 · 纪要导出）
 *
 * 参考 ai-meeting-workstation 的产品形态：
 *   - 双录音通道：麦克风（我方发言）+ 系统内录（线上会议对方声音，需虚拟声卡或立体声混音）
 *   - 双转写通道：云端（若道 STT / 硅基流动 / 火山）+ 本机（sherpa-onnx 流式识别，由宿主完成）
 *   - 说话人：实时声纹逐句归属、文件转写离线分离；名册可在记录页改名/合并/改派
 *   - AI 参会：随时以会议上下文邀请 AI 发言，观点写回会议时间线
 *   - 会后纪要：LLM 生成结构化 Markdown 纪要，可导出文件
 *   - 会议持久化：本地 JSON 存储（.ruodao-meeting-assistant），无第三方依赖
 *
 * 零第三方依赖，Node >= 18。
 *
 * 环境变量：
 *   RUODAO_AUDIO_DEVICE          麦克风设备名（dshow）
 *   RUODAO_SYSTEM_AUDIO_DEVICE   系统内录设备名（如 virtual-audio-capturer / 立体声混音）
 *   RUODAO_CAPTURE_SECONDS       每轮录音时长，默认 12 秒
 *   RUODAO_STT_CHANNEL           cloud | local（默认 cloud）
 *   RUODAO_STT_PRESET            云端预设 host | siliconflow | volc（默认 host）
 *   RUODAO_STT_*                 host 预设（宿主模型绑定自动注入，OpenAI 兼容）
 *   RUODAO_SILICONFLOW_API_KEY   硅基流动 Key（预设 siliconflow）
 *   RUODAO_VOLC_APP_ID / RUODAO_VOLC_ACCESS_KEY  火山引擎凭证（预设 volc，volc.seedasr.auc 大模型）
 *   RUODAO_LOCAL_STT_BASE_URL    本地转写服务根地址（OpenAI 兼容 /audio/transcriptions）
 *   RUODAO_LOCAL_STT_API_KEY     本地转写 Key（通常可留空）
 *   RUODAO_LOCAL_STT_MODEL       本地转写模型名（默认 whisper-1）
 *   RUODAO_LLM_*                 对话模型（宿主模型绑定自动注入）
 *   RUODAO_MEETING_CONTEXT       会议主题与背景（拼进 AI 提示词）
 *   RUODAO_MEETING_ROLE          AI 参谋人设（默认「资深会议参谋」）
 *
 * 输出（stdout，JSON）：{ state: "succeeded" | "failed", ... }
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const env = (k, d = "") => (process.env[k] ?? d).trim();

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try { resolve(data.trim() ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function fail(message, extra = {}) {
  emit({ state: "failed", error: message, ...extra });
  process.exit(1);
}

function run(cmd, args, { capture = true, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "", stderr = "", done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill("killed"); resolve({ code: 124, stdout, stderr: stderr + "\ntimeout" }); } }, timeoutMs);
    if (capture) child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }); } });
    child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); } });
  });
}

/* ---------------- 会议存储（本地 JSON，隐私数据不出本机） ---------------- */

function dataDir() {
  return env("RUODAO_MEETING_DATA_DIR") || path.join(homedir(), ".ruodao-meeting-assistant");
}

function storeFile() {
  return path.join(dataDir(), "meetings.json");
}

/* ---------------- 商用记忆（客户档案 + 长期记忆，先起草、人工确认后才入库生效） ---------------- */

function memoryFile() {
  return path.join(dataDir(), "memory.json");
}

async function loadMemory() {
  const file = memoryFile();
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data) ? data : [];
  }
  catch { return []; }
}

async function saveMemory(entries) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(memoryFile(), JSON.stringify(entries, null, 2), "utf8");
}

/** 拼进 AI 提示词的长期记忆：该客户档案条目 + 最近 N 条其他已确认记忆。 */
function memoryPromptBlock(entries, customer, limit = 6) {
  const confirmed = entries.filter((entry) => entry.status === "confirmed" && entry.text);
  if (!confirmed.length) return "";
  const own = customer ? confirmed.filter((entry) => (entry.customer || "").trim() === customer.trim()) : [];
  const others = confirmed.filter((entry) => !own.includes(entry)).slice(-limit);
  const lines = [...own, ...others].slice(-limit + own.length)
    .map((entry) => `- [${entry.customer || "通用"}] ${String(entry.text).trim()}`);
  return lines.length ? `【客户档案与长期记忆】\n${lines.join("\n")}\n` : "";
}


function recordingsDir(meetingId) {
  return path.join(dataDir(), "recordings", meetingId);
}

async function loadMeetings() {
  const file = storeFile();
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data) ? data.map((meeting) => normalizeMeeting(meeting)) : [];
  }
  catch { return []; }
}

async function saveMeetings(meetings) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(storeFile(), JSON.stringify(meetings, null, 2), "utf8");
}

async function withMeeting(id, mutator) {
  const meetings = await loadMeetings();
  const index = meetings.findIndex((m) => m.id === id);
  if (index === -1) fail(`会议不存在：${id}`);
  const meeting = mutator(meetings[index]);
  meetings[index] = meeting;
  await saveMeetings(meetings);
  return meeting;
}

function defaultSpeakerName(id) {
  if (id === "self" || id === "mic") return "我方";
  if (id === "remote" || id === "system") return "会议方";
  if (id === "ai") return "AI 参谋";
  if (id === "file") return "录音文件";
  if (/^S\d+$/i.test(id)) return `发言人 ${id.slice(1)}`;
  return id || "未知发言人";
}

/** 说话人名册与统计始终由 segments 重新推导：改名/合并/删句后不会出现计数漂移。
 *  已有名册里的名字优先——声纹只负责「谁」，用户改的名字负责「叫什么」。 */
function syncSpeakers(meeting) {
  const roster = new Map();
  for (const speaker of Array.isArray(meeting.speakers) ? meeting.speakers : []) {
    if (!speaker?.id) continue;
    const id = String(speaker.id);
    roster.set(id, { ...speaker, id, name: String(speaker.name || defaultSpeakerName(id)), segmentCount: 0, firstAt: null, lastAt: null });
  }
  for (const segment of meeting.segments) {
    const id = String(segment.speakerId || segment.speaker || "unknown").trim() || "unknown";
    segment.speakerId = id;
    let entry = roster.get(id);
    if (!entry) {
      entry = { id, name: String(segment.speaker || defaultSpeakerName(id)), segmentCount: 0, firstAt: null, lastAt: null };
      roster.set(id, entry);
    }
    entry.segmentCount += 1;
    const at = Number(segment.at) || 0;
    if (at) {
      if (entry.firstAt == null || at < entry.firstAt) entry.firstAt = at;
      if (entry.lastAt == null || at > entry.lastAt) entry.lastAt = at;
    }
    segment.speaker = entry.name;
  }
  meeting.speakers = [...roster.values()]
    .filter((speaker) => speaker.segmentCount > 0)
    .sort((a, b) => (a.firstAt ?? Number.MAX_SAFE_INTEGER) - (b.firstAt ?? Number.MAX_SAFE_INTEGER));
  return meeting;
}

function normalizeMeeting(meeting) {
  meeting.segments = Array.isArray(meeting.segments) ? meeting.segments : [];
  meeting.speakers = Array.isArray(meeting.speakers) ? meeting.speakers : [];
  meeting.source = meeting.source || (meeting.segments.some((segment) => segment.channel === "file") ? "file" : "live");
  if (!meeting.engine) meeting.engine = meeting.source === "file" ? "local" : "";
  return syncSpeakers(meeting);
}

function meetingDurationMs(meeting) {
  if (Number(meeting.durationMs) > 0) return Number(meeting.durationMs);
  const start = Number(meeting.createdAt) || 0;
  const lastSegmentAt = meeting.segments.reduce((max, segment) => Math.max(max, Number(segment.at) || 0), 0);
  const end = Number(meeting.endedAt) || lastSegmentAt;
  return Math.max(0, end - start);
}

function meetingSummary(meeting) {
  return {
    id: meeting.id, title: meeting.title, context: meeting.context ?? "",
    status: meeting.status, createdAt: meeting.createdAt, endedAt: meeting.endedAt ?? null,
    segmentCount: meeting.segments.length,
    speakerCount: meeting.speakers.length,
    durationMs: meetingDurationMs(meeting),
    source: meeting.source,
    engine: meeting.engine ?? "",
    customer: meeting.customer ?? "",
    participants: meeting.participants ?? "",
    hasMinutes: Boolean(meeting.minutes),
  };
}

/* ---------------- 音频采集：麦克风 + 系统内录并行 ---------------- */

async function captureWav(device, seconds, tag, destFile) {
  await mkdir(path.dirname(destFile), { recursive: true });
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "dshow", "-i", `audio=${device}`,
    "-t", String(seconds), "-ac", "1", "-ar", "16000",
    "-y", destFile,
  ];
  const rec = await run("ffmpeg", args, { capture: false, timeoutMs: (seconds + 15) * 1000 });
  if (rec.code !== 0) {
    await rm(destFile, { force: true });
    return { ok: false, error: `录音失败（exit ${rec.code}）：${rec.stderr.slice(-300)}` };
  }
  return { ok: true, file: destFile };
}

function startCapture(device, seconds, tag, destFile) {
  return captureWav(device, seconds, tag, destFile);
}

/* ---------------- 转写：云端 / 本地 双通道 ---------------- */

function sttChannel() {
  const channel = env("RUODAO_STT_CHANNEL", "cloud").toLowerCase();
  return channel === "local" ? "local" : "cloud";
}

/** 解析 16k 单声道 PCM16 wav，返回时长（秒）与归一化 RMS 能量（0~1）。
 *  用于静音门限：静音/纯噪声段直接跳过转写，既省钱又避免 whisper 幻听。 */
function wavStats(buf) {
  try {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === "data") {
        const n = Math.min(Math.floor(size / 2), Math.floor((buf.length - offset - 8) / 2));
        if (n <= 0) return null;
        let sumSquares = 0;
        for (let i = 0; i < n; i++) {
          const v = buf.readInt16LE(offset + 8 + i * 2) / 32768;
          sumSquares += v * v;
        }
        return { seconds: n / 16000, rms: Math.sqrt(sumSquares / n) };
      }
      offset += 8 + size + (size % 2);
    }
  } catch { /* 格式异常按有音频处理 */ }
  return null;
}

/** whisper 对静音/噪声的典型幻听黑名单（中英俄都有，命中即丢弃整段）。 */
const HALLUCINATION_PATTERNS = [
  /^(谢谢观看|谢谢收看|感谢观看|请订阅|点赞关注|订阅频道|字幕由?.*提供|字幕组)/,
  /(subtitles? (by|for)|amara\.org|please subscribe|thank you for watching)/i,
  /^(в?а?ш?е|ладно|приятного|до свидания|музыка|аплодисменты)[.!\s]*$/i,
];

/** 判定一段转写文本是不是噪声幻听：命中黑名单、或过短且不含 CJK（语言为中文时）。 */
function isJunkTranscript(text, language) {
  const t = (text || "").trim();
  if (!t) return true;
  if (HALLUCINATION_PATTERNS.some((re) => re.test(t))) return true;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  // 中文会议模式下：纯英文/数字/西里尔字母（whisper 静音幻听高发）且无任何汉字 → 丢弃
  if ((language || "zh") === "zh" && cjk === 0 && t.replace(/[\s\d.,!?;:'"()\-a-zA-Zа-яА-ЯёЁ]/g, "").length === 0) return true;
  // 纯英文/字符混杂且极短（<4 字符）多半是噪声，正常中文发言不会这么短
  if (cjk === 0 && t.length < 4 && (language || "zh") === "zh") return true;
  return false;
}

/* ---------------- 转写：多通道 provider 抽象 ---------------- */

/**
 * 转写服务选择（尽量让用户只「选」不「填」）：
 *   RUODAO_STT_SERVICE  一个字段选定服务：host(若道绑定) | siliconflow(硅基流动) | volc(火山) | local(本地)
 *                       兼容中文别名：绑定/若道、硅基流动、火山、本地
 *   RUODAO_STT_CREDENTIAL  唯一凭证字段，按服务解析：
 *                       siliconflow → API Key；volc → AppID:AccessKey；host/local 留空
 * 兼容旧字段 RUODAO_STT_CHANNEL / RUODAO_STT_PRESET / RUODAO_SILICONFLOW_API_KEY / RUODAO_VOLC_*。
 */

const VOLC_AUC_SUBMIT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const VOLC_AUC_QUERY = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";

function sttServiceName() {
  const raw = env("RUODAO_STT_SERVICE").toLowerCase();
  if (/硅基|sensevoice|silicon/.test(raw)) return "siliconflow";
  if (/火山|volc/.test(raw)) return "volc";
  if (/本地|local/.test(raw)) return "local";
  if (/绑定|若道|host|ruodao/.test(raw)) return "host";
  if (["siliconflow", "volc", "local", "host"].includes(raw)) return raw;
  // 兼容旧配置字段
  const channel = (env("RUODAO_STT_CHANNEL", "cloud") || "cloud").toLowerCase();
  const preset = (env("RUODAO_STT_PRESET", "host") || "host").toLowerCase();
  if (channel === "local") return "local";
  if (preset === "siliconflow" || preset === "volc") return preset;
  return "host";
}

function sttEndpoint() {
  const svc = sttServiceName();
  const credential = env("RUODAO_STT_CREDENTIAL");
  if (svc === "local") {
    return {
      service: "local",
      preset: "local",
      channel: "local",
      base: env("RUODAO_LOCAL_STT_BASE_URL", "http://127.0.0.1:8000/v1"),
      key: env("RUODAO_LOCAL_STT_API_KEY"),
      model: env("RUODAO_LOCAL_STT_MODEL", "whisper-1"),
      missing: "本地转写服务未运行：可用 local-asr 插件「一键配置」安装并启动（默认 http://127.0.0.1:8000/v1）",
    };
  }
  if (svc === "siliconflow") {
    return {
      service: "siliconflow",
      preset: "siliconflow",
      channel: "cloud",
      base: "https://api.siliconflow.cn/v1",
      key: credential || env("RUODAO_SILICONFLOW_API_KEY"),
      model: env("RUODAO_STT_MODEL", "FunAudioLLM/SenseVoiceSmall"),
      missing: "硅基流动转写需要在「转写凭证」里填 API Key（siliconflow.cn 注册即有免费额度）",
    };
  }
  if (svc === "volc") {
    const legacyApp = env("RUODAO_VOLC_APP_ID");
    const legacyKey = env("RUODAO_VOLC_ACCESS_KEY");
    let appId = legacyApp, accessKey = legacyKey;
    if (credential && credential.includes(":")) {
      const [a, b] = credential.split(":");
      appId = a.trim() || appId;
      accessKey = b.trim() || accessKey;
    }
    return {
      service: "volc",
      preset: "volc",
      channel: "cloud",
      appId,
      accessKey,
      missing: "火山转写需要在「转写凭证」里填 AppID:AccessKey（console.volcengine.com 开通语音技术后获取）",
    };
  }
  return {
    service: "host",
    preset: "host",
    channel: "cloud",
    base: env("RUODAO_STT_BASE_URL"),
    key: env("RUODAO_STT_API_KEY"),
    model: env("RUODAO_STT_MODEL", "whisper-1"),
    missing: "云端转写未配置：请在「模型管理」选择转写模型，或在「转写服务」里改选 硅基流动 / 火山 / 本地",
  };
}

/** 火山引擎录音文件识别 2.0（volc.seedasr.auc）：submit + 轮询 query，适合 12 秒段与整段录音文件 */
async function volcTranscribe(wavBuffer, ep) {
  const requestId = crypto.randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "X-Api-App-Key": ep.appId,
    "X-Api-Access-Key": ep.accessKey,
    "X-Api-Resource-Id": "volc.seedasr.auc",
    "X-Api-Request-Id": requestId,
  };
  let submitRes;
  try {
    submitRes = await fetch(VOLC_AUC_SUBMIT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user: { uid: "ruodao-meeting-assistant" },
        audio: { format: "wav", data: wavBuffer.toString("base64") },
        request: { model_name: "bigmodel" },
      }),
    });
  } catch (error) {
    fail(`火山转写网络失败：${String(error?.cause?.message || error)}`);
  }
  if (!submitRes.ok) fail(`火山转写 submit 失败 ${submitRes.status}: ${(await submitRes.text()).slice(0, 300)}`);

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let qRes;
    try {
      qRes = await fetch(`${VOLC_AUC_QUERY}?appid=${encodeURIComponent(ep.appId)}&request_id=${encodeURIComponent(requestId)}`, { headers });
    } catch (error) {
      fail(`火山转写 query 网络失败：${String(error?.cause?.message || error)}`);
    }
    if (!qRes.ok) fail(`火山转写 query 失败 ${qRes.status}: ${(await qRes.text()).slice(0, 300)}`);
    const q = await qRes.json();
    // 参考上游实现：result.text 出现即完成；明确失败码则直接报错
    if (q?.result?.text !== undefined) return String(q.result.text || "").trim();
    if (q?.response && q.response.status && Number(q.response.status) >= 2000) {
      fail(`火山转写失败：${JSON.stringify(q.response).slice(0, 300)}`);
    }
  }
  fail("火山转写查询超时（120 秒），请稍后重试或减小录音时长");
}

async function transcribeWav(wavBuffer, { prompt = "" } = {}) {
  const ep = sttEndpoint();
  const language = env("RUODAO_STT_LANGUAGE", "zh");
  if (ep.preset === "volc") {
    if (!ep.appId || !ep.accessKey) fail(ep.missing);
    return volcTranscribe(wavBuffer, ep);
  }
  if (ep.preset === "siliconflow" && !ep.key) fail(ep.missing);
  const base = (ep.base || "").replace(/\/+$/, "");
  if (!base) fail(ep.missing);
  const model = ep.model;
  // 引擎自适应：豆包/方舟 ASR（doubao-seed-asr 等）与 GLM-ASR 只接受极简参数——
  // 不支持 language/temperature/prompt，官方仅承诺 pcm_s16le（wav 被拒时需剥掉 44 字节
  // RIFF 头改发裸 pcm 重试）。与宿主 transcribeInterviewAudioCloud 保持同一套规则。
  const isDoubao = /doubao[-_]?seed[-_]?asr|seed[-_.]?asr|[-_.]asr(?:[-_.\d]|$)/i.test(model);
  const isGlm = /glm[-_.]?asr/i.test(model);
  const minimalEngine = isDoubao || isGlm;
  const send = (rawPcm) => {
    const form = new FormData();
    if (rawPcm) {
      form.append("file", new Blob([wavBuffer.subarray(44)], { type: "audio/pcm" }), "segment.pcm");
    } else {
      form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "segment.wav");
    }
    form.append("model", model);
    if (!minimalEngine) {
      if (language) form.append("language", language);
      form.append("temperature", "0");
      // 用最近的真实转写内容做 whisper prompt 偏置：既提升术语连贯性，也显著减少静音幻听
      if (prompt) form.append("prompt", prompt.slice(-200));
    } else {
      form.append("response_format", "json");
    }
    const headers = {};
    if (ep.key) headers.Authorization = `Bearer ${ep.key}`;
    return fetch(`${base}/audio/transcriptions`, { method: "POST", headers, body: form });
  };
  let res;
  try {
    res = await send(false);
    // wav 被拒（方舟 ASR 常见）→ 裸 pcm 重试一次
    if (!res.ok && minimalEngine) res = await send(true);
  } catch (error) {
    fail(`${ep.channel === "local" ? "本地" : "云端"}STT 请求网络失败：${String(error?.cause?.message || error)}（${base}）`);
  }
  if (!res.ok) fail(`${ep.channel === "local" ? "本地" : "云端"}STT 请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.text ?? "").trim();
}

async function transcribeCapture(capture, { keepAudio = false, prompt = "" } = {}) {
  if (!capture.ok) return { ok: false, error: capture.error };
  const buf = await readFile(capture.file);
  // 静音门限：RMS 低于阈值视为无人说话，直接跳过转写（可用 RUODAO_SILENCE_RMS 调灵敏度，越小越灵敏）
  const stats = wavStats(buf);
  const silenceRms = Number(env("RUODAO_SILENCE_RMS", "0.006")) || 0.006;
  if (stats && stats.rms < silenceRms) {
    if (!keepAudio) await rm(capture.file, { force: true });
    return { ok: true, text: "", silent: true };
  }
  try {
    const text = await transcribeWav(buf, { prompt });
    if (!keepAudio) await rm(capture.file, { force: true });
    if (isJunkTranscript(text, env("RUODAO_STT_LANGUAGE", "zh"))) {
      return { ok: true, text: "", silent: true };  // 幻听垃圾按静音处理，不进时间线
    }
    return { ok: true, text, audioFile: keepAudio ? capture.file : undefined };
  } catch (error) {
    if (!keepAudio) await rm(capture.file, { force: true });
    throw error;
  }
}

/* ---------------- LLM（OpenAI 兼容，三通道大脑） ---------------- */

/**
 * AI 大脑通道（参考 ai-meeting-workstation 的 provider 抽象）：
 *   host  宿主模型绑定（默认，模型管理注入 RUODAO_LLM_*）
 *   cloud 云端 OpenAI 兼容服务（默认 DeepSeek，需用户自己的 Key）
 *   local 本地 OpenAI 兼容服务（默认 Ollama 11434）
 * 无凭证时明确报错，不静默降级。
 */
function llmEndpoint() {
  const channel = (env("RUODAO_LLM_CHANNEL", "host") || "host").toLowerCase();
  if (channel === "cloud") {
    return {
      channel,
      base: env("RUODAO_CLOUD_LLM_BASE_URL", "https://api.deepseek.com/v1"),
      key: env("RUODAO_CLOUD_LLM_API_KEY"),
      model: env("RUODAO_CLOUD_LLM_MODEL", "deepseek-chat"),
      missing: "云端大脑需要 API Key：请在会议助手设置里填写「云端模型 Key」（如 DeepSeek Key），或把 AI 大脑切回 host/local",
    };
  }
  if (channel === "local") {
    return {
      channel,
      base: env("RUODAO_LOCAL_LLM_BASE_URL", "http://127.0.0.1:11434/v1"),
      key: env("RUODAO_LOCAL_LLM_API_KEY"),
      model: env("RUODAO_LOCAL_LLM_MODEL", "qwen2.5:7b"),
      missing: "本地大脑需要本机 OpenAI 兼容服务：如 Ollama（ollama serve 后执行 ollama pull qwen2.5:7b），或在设置里修改本地模型地址",
    };
  }
  return {
    channel: "host",
    base: env("RUODAO_LLM_BASE_URL"),
    key: env("RUODAO_LLM_API_KEY"),
    model: env("RUODAO_LLM_MODEL", "gpt-4o-mini"),
    missing: "缺少 LLM 配置：请先在「模型管理」选择文本模型（LLM 绑定），或把 AI 大脑切到 cloud/local 通道",
  };
}

async function chatJson(messages, maxTokens = 1200) {
  const ep = llmEndpoint();
  const base = ep.base.replace(/\/+$/, "");
  if (!base || (ep.channel === "cloud" && !ep.key)) fail(ep.missing);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}),
      },
      body: JSON.stringify({
        model: ep.model,
        messages,
        temperature: 0.4,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
    });
  } catch (error) {
    fail(`LLM 请求网络失败：${String(error?.cause?.message || error)}。请检查${ep.channel === "local" ? "本地模型服务是否已启动" : "模型服务是否可达"}`);
  }
  if (!res.ok) fail(`LLM 请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function parseJsonLoose(text) {
  try { return JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()); }
  catch { return null; }
}

function transcriptText(meeting, limit = 60) {
  return meeting.segments.slice(-limit)
    .map((s) => `[${new Date(s.at).toLocaleTimeString("zh-CN")} ${s.speaker}] ${s.text}`)
    .join("\n");
}

/* ---------------- doctor ---------------- */

async function doctor() {
  const report = { state: "succeeded", checks: {} };
  const ffmpeg = await run("ffmpeg", ["-version"], { timeoutMs: 8000 });
  report.checks.ffmpeg = { ok: ffmpeg.code === 0, hint: ffmpeg.code === 0 ? "found" : "请安装 ffmpeg 并加入 PATH（https://ffmpeg.org）" };
  const devices = ffmpeg.code === 0 ? await run("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { timeoutMs: 10000 }) : { stderr: "" };
  const audioDevices = [...devices.stderr.matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1]);
  const loopbackReady = audioDevices.some((name) => /virtual-audio-capturer|立体声混音|stereo mix/i.test(name));
  report.checks.audioDevices = audioDevices;
  report.checks.mic = env("RUODAO_AUDIO_DEVICE")
    ? { ok: audioDevices.length === 0 || audioDevices.includes(env("RUODAO_AUDIO_DEVICE")), value: env("RUODAO_AUDIO_DEVICE") }
    : { ok: false, hint: "未设置 RUODAO_AUDIO_DEVICE，请从 audioDevices 列表选择麦克风" };
  report.checks.systemAudio = env("RUODAO_SYSTEM_AUDIO_DEVICE")
    ? { ok: true, value: env("RUODAO_SYSTEM_AUDIO_DEVICE") }
    : { ok: false, hint: "未设置系统内录设备；线上会议需启用「立体声混音」或安装 virtual-audio-capturer 后填入设备名。仅本地会议可只用麦克风" };
  report.checks.loopbackDeviceAvailable = loopbackReady;
  // 自动配置推荐：优先选名称含「麦克风/mic」的设备作麦克风；含虚拟回环/立体声混音的作系统内录。
  const recommendedMic = audioDevices.find((name) => /麦克风|microphone|\bmic\b/i.test(name)) ?? audioDevices[0] ?? "";
  const recommendedLoopback = audioDevices.find((name) => /virtual-audio-capturer|立体声混音|stereo mix/i.test(name)) ?? "";
  report.checks.recommendations = {
    mic: env("RUODAO_AUDIO_DEVICE") ? "" : recommendedMic,
    systemAudio: env("RUODAO_SYSTEM_AUDIO_DEVICE") ? "" : recommendedLoopback,
  };
  report.autoConfig = {
    canAutoConfigure: Boolean(recommendedMic),
    apply: {
      ...(env("RUODAO_AUDIO_DEVICE") ? {} : { RUODAO_AUDIO_DEVICE: recommendedMic }),
      ...(env("RUODAO_SYSTEM_AUDIO_DEVICE") || !recommendedLoopback ? {} : { RUODAO_SYSTEM_AUDIO_DEVICE: recommendedLoopback }),
    },
  };
  const sttEp0 = sttEndpoint();
  const sttReady = (ep0) =>
    ep0.service === "volc" ? Boolean(ep0.appId && ep0.accessKey)
      : ep0.service === "siliconflow" ? Boolean(ep0.key)
      : true; // host 有缺省提示；local 有默认地址，实际可用性由下方探测
  let localAlive = false;
  if (sttEp0.service === "local") {
    try {
      const r = await fetch(`${sttEp0.base.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(1500) });
      localAlive = r.ok;
    } catch { localAlive = false; }
  }
  const cloudReady = sttEp0.channel === "cloud" && sttReady(sttEp0);
  report.checks.stt = {
    service: sttEp0.service,
    language: env("RUODAO_STT_LANGUAGE", "zh"),
    silenceRms: Number(env("RUODAO_SILENCE_RMS", "0.006")) || 0.006,
    cloud: { ok: cloudReady, baseUrl: sttEp0.base || (sttEp0.service === "volc" ? "volc.seedasr.auc（火山大模型）" : sttEp0.service === "siliconflow" ? "api.siliconflow.cn（SenseVoice）" : "(未设置)"), model: sttEp0.model || "bigmodel" },
    local: { ok: sttEp0.service === "local" ? localAlive : Boolean(env("RUODAO_LOCAL_STT_BASE_URL")), baseUrl: sttEp0.base || "(未设置)", model: sttEp0.model },
    ok: sttEp0.service === "local" ? localAlive : cloudReady,
    note: sttEp0.channel === "cloud" && !sttReady(sttEp0) ? sttEp0.missing
      : sttEp0.service === "local" && !localAlive ? "本地转写服务未运行：可用 local-asr 插件「启动本地转写服务」" : "",
  };
  const ep = llmEndpoint();
  report.checks.llm = {
    ok: ep.channel === "cloud" ? Boolean(ep.key) : Boolean(ep.base),
    channel: ep.channel,
    baseUrl: ep.base || "(未设置)",
    model: ep.model,
    note: ep.channel === "cloud" && !ep.key ? "已选云端大脑但未填 Key" : ep.channel === "local" && !ep.base ? "已选本地大脑但服务地址未设置" : "",
  };
  report.checks.dataDir = { ok: true, value: dataDir() };
  report.ok = report.checks.ffmpeg.ok && report.checks.stt.ok && report.checks.llm.ok && report.checks.mic.ok;
  emit(report);
}

/* ---------------- 会议 CRUD ---------------- */

async function meetingCreate(stdin) {
  const title = (stdin.title || "").trim() || `会议 ${new Date().toLocaleString("zh-CN")}`;
  const meeting = normalizeMeeting({
    id: crypto.randomUUID(),
    title,
    context: (stdin.context ?? env("RUODAO_MEETING_CONTEXT") ?? "").trim(),
    status: "live",
    source: "live",
    engine: String(stdin.engine ?? "").trim(),
    customer: String(stdin.customer ?? "").trim(),
    participants: String(stdin.participants ?? "").trim(),
    durationMs: 0,
    createdAt: Date.now(),
    endedAt: null,
    segments: [],
    speakers: [],
    minutes: "",
  });
  const meetings = await loadMeetings();
  meetings.push(meeting);
  await saveMeetings(meetings);
  emit({ state: "succeeded", meeting });
}

async function meetingUpdate(stdin) {
  const meetingId = (stdin.id || "").trim();
  if (!meetingId) fail("缺少 id：请指定要修改的会议");
  const patch = {};
  if (typeof stdin.title === "string" && stdin.title.trim()) patch.title = stdin.title.trim();
  if (typeof stdin.context === "string") patch.context = stdin.context.trim();
  if (typeof stdin.customer === "string") patch.customer = stdin.customer.trim();
  if (typeof stdin.participants === "string") patch.participants = stdin.participants.trim();
  if (stdin.status === "live" || stdin.status === "ended") patch.status = stdin.status;
  if (!Object.keys(patch).length) fail("没有可更新的内容（title / context / status）");
  const meeting = await withMeeting(meetingId, (m) => {
    const next = { ...m, ...patch };
    if (patch.status === "live") next.endedAt = null;
    return syncSpeakers(next);
  });
  emit({ state: "succeeded", meeting, meetingSummary: meetingSummary(meeting) });
}

/** 说话人维护：改名（name）或合并（mergeInto）。合并常用于离线分离把同一人拆成两个 S 编号。 */
async function speakerUpdate(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  const speakerId = String(stdin.speakerId || "").trim();
  if (!meetingId || !speakerId) fail("缺少 meetingId / speakerId");
  const name = String(stdin.name ?? "").trim();
  const mergeInto = String(stdin.mergeInto || "").trim();
  const meeting = await withMeeting(meetingId, (m) => {
    const roster = new Map((Array.isArray(m.speakers) ? m.speakers : []).map((speaker) => [String(speaker.id), { ...speaker }]));
    if (mergeInto && mergeInto !== speakerId) {
      const target = roster.get(mergeInto) ?? { id: mergeInto, name: defaultSpeakerName(mergeInto) };
      roster.set(mergeInto, target);
      for (const segment of m.segments) {
        if (String(segment.speakerId || segment.speaker) === speakerId) {
          segment.speakerId = mergeInto;
          segment.speaker = target.name;
        }
      }
      roster.delete(speakerId);
    } else {
      if (!name) fail("缺少新名字 name");
      const source = roster.get(speakerId) ?? { id: speakerId, name: defaultSpeakerName(speakerId) };
      source.name = name;
      roster.set(speakerId, source);
      for (const segment of m.segments) {
        if (String(segment.speakerId || segment.speaker) === speakerId) segment.speaker = name;
      }
    }
    return syncSpeakers({ ...m, speakers: [...roster.values()] });
  });
  emit({ state: "succeeded", meetingId, speakers: meeting.speakers, meeting });
}

async function segmentUpdate(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  const segmentId = (stdin.segmentId || "").trim();
  if (!meetingId || !segmentId) fail("缺少 meetingId / segmentId");
  const meeting = await withMeeting(meetingId, (m) => {
    const segment = m.segments.find((item) => item.id === segmentId);
    if (!segment) fail(`发言不存在：${segmentId}`);
    if (typeof stdin.text === "string" && stdin.text.trim()) segment.text = stdin.text.trim();
    if (stdin.speakerId != null && String(stdin.speakerId).trim()) {
      segment.speakerId = String(stdin.speakerId).trim();
      segment.speaker = defaultSpeakerName(segment.speakerId);
    }
    return syncSpeakers(m);
  });
  emit({ state: "succeeded", meetingId, segmentId, speakers: meeting.speakers, segmentCount: meeting.segments.length });
}

async function segmentDelete(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  const segmentId = (stdin.segmentId || "").trim();
  if (!meetingId || !segmentId) fail("缺少 meetingId / segmentId");
  const meeting = await withMeeting(meetingId, (m) => {
    const next = m.segments.filter((segment) => segment.id !== segmentId);
    if (next.length === m.segments.length) fail(`发言不存在：${segmentId}`);
    return syncSpeakers({ ...m, segments: next });
  });
  emit({ state: "succeeded", meetingId, segmentId, speakers: meeting.speakers, segmentCount: meeting.segments.length });
}

async function meetingsList() {
  const meetings = await loadMeetings();
  emit({
    state: "succeeded",
    total: meetings.length,
    dataDir: dataDir(),
    meetings: meetings.slice().reverse().map(meetingSummary),
  });
}

async function meetingGet(stdin) {
  const meetings = await loadMeetings();
  const meeting = meetings.find((m) => m.id === (stdin.id || "").trim());
  if (!meeting) fail(`会议不存在：${stdin.id}`);
  emit({ state: "succeeded", meeting });
}

async function meetingEnd(stdin) {
  const meeting = await withMeeting((stdin.id || "").trim(), (m) => syncSpeakers({ ...m, status: "ended", endedAt: Date.now() }));
  emit({ state: "succeeded", meeting, meetingSummary: meetingSummary(meeting) });
}

async function meetingDelete(stdin) {
  const meetings = await loadMeetings();
  const next = meetings.filter((m) => m.id !== (stdin.id || "").trim());
  if (next.length === meetings.length) fail(`会议不存在：${stdin.id}`);
  await saveMeetings(next);
  await rm(recordingsDir((stdin.id || "").trim()), { recursive: true, force: true });
  emit({ state: "succeeded", deleted: stdin.id });
}

/* ---------------- 实时录音转写段 ---------------- */

async function recordSegment(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  if (!meetingId) fail("缺少 meetingId：请先创建或选择会议");
  const meetings = await loadMeetings();
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) fail(`会议不存在：${meetingId}`);
  const seconds = Math.min(Math.max(Number(env("RUODAO_CAPTURE_SECONDS", "12")) || 12, 3), 120);
  const micDevice = env("RUODAO_AUDIO_DEVICE");
  const sysDevice = env("RUODAO_SYSTEM_AUDIO_DEVICE");
  if (!micDevice && !sysDevice) fail("缺少录音设备：请至少配置 RUODAO_AUDIO_DEVICE（麦克风）或 RUODAO_SYSTEM_AUDIO_DEVICE（系统内录）");

  const captures = [];
  const stamp = Date.now();
  if (micDevice) captures.push({ channel: "mic", speaker: "我方", promise: startCapture(micDevice, seconds, "mic", path.join(recordingsDir(meetingId), `${stamp}-mic.wav`)) });
  if (sysDevice) captures.push({ channel: "system", speaker: "会议方", promise: startCapture(sysDevice, seconds, "sys", path.join(recordingsDir(meetingId), `${stamp}-system.wav`)) });
  // 用最近几段真实转写做 whisper prompt 偏置：提升术语连贯、抑制静音幻听
  const recentPrompt = meeting.segments.filter((s) => s.text).slice(-3).map((s) => s.text).join(" ");
  const results = await Promise.all(captures.map(async (entry) => ({ ...entry, result: await transcribeCapture(await entry.promise, { keepAudio: true, prompt: recentPrompt }) })));

  const segments = [];
  const errors = [];
  for (const entry of results) {
    if (entry.result.ok && entry.result.text) {
      segments.push({ id: crypto.randomUUID(), at: Date.now(), channel: entry.channel, speaker: entry.speaker, text: entry.result.text, audioPath: entry.result.audioFile });
    } else if (entry.result.ok && entry.result.silent) {
      // 静音/噪声段：直接跳过，不算错误
    } else if (!entry.result.ok) {
      errors.push(`${entry.channel}: ${entry.result.error}`);
    }
  }
  if (segments.length) {
    await withMeeting(meetingId, (m) => ({ ...m, segments: [...m.segments, ...segments] }));
  } else if (!errors.length) {
    errors.push("本轮未识别到有效语音（已过滤静音与噪声），可直接进入下一轮");
  }
  emit({ state: "succeeded", meetingId, segments, errors, captureSeconds: seconds });
}

/* ---------------- AI 参会发言 ---------------- */

async function aiRespond(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  if (!meetingId) fail("缺少 meetingId：请先创建或选择会议");
  const meetings = await loadMeetings();
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) fail(`会议不存在：${meetingId}`);
  if (!meeting.segments.length) fail("当前会议还没有任何转写内容，无法邀请 AI 发言");
  const joinMode = String(stdin.mode ?? "").trim() === "join";
  const instruction = (stdin.instruction || "").trim()
    || (joinMode ? "结合最新讨论自然接话" : "请针对当前会议讨论给出你的观点与建议");
  const role = env("RUODAO_MEETING_ROLE") || "资深会议参谋";
  const context = meeting.context ? `【会议背景】${meeting.context}\n` : "";
  const participants = meeting.participants ? `【参会人】${meeting.participants}\n` : "";
  const memoryBlock = memoryPromptBlock(await loadMemory(), meeting.customer);
  // 参会模式：AI 以「参会者」身份全程在场，听到新讨论就自然接话；
  // 附上自己最近的发言，避免复读。普通模式保持「被邀请发言」的顾问口吻。
  const previousAiReplies = joinMode
    ? meeting.segments.filter((s) => s.channel === "ai").slice(-4)
    : [];
  const previousBlock = previousAiReplies.length
    ? `【你之前的发言】\n${previousAiReplies.map((s) => `- ${s.text}`).join("\n")}\n`
    : "";
  const system = joinMode
    ? `你是${role}，正以参会者身份全程参与这场会议（不是被点名的外部顾问），需要像真人一样听最新讨论并自然接话。${context}${participants}${memoryBlock}${previousBlock}要求：直接针对刚才的讨论给出你的判断或建议，口语化、可直接朗读，1-3 句话以内；不要重复你之前说过的观点；如果讨论没有需要补充的地方，可以只表示认同并推进。先给可直接照读的『发言稿』（不超过 80 字），再给不超过 3 条『要点』。只输出一个 JSON 对象：{"reply":"...","points":["..."]}`
    : `你是${role}，正在列席一场会议并被邀请发言。${context}${participants}${memoryBlock}要求：观点直接、可执行，先给一段可直接照读的『发言稿』（不超过 150 字），再给不超过 5 条『要点』。只输出一个 JSON 对象：{"reply":"...","points":["..."]}`;
  const content = await chatJson([
    { role: "system", content: system },
    { role: "user", content: `【最近的会议发言】\n${transcriptText(meeting)}${joinMode ? "\n\n【参会关注点】" : "\n\n【邀请指令】"}${instruction}` },
  ], joinMode ? 700 : 900);
  const parsed = parseJsonLoose(content) ?? { reply: content.trim(), points: [] };
  if (!parsed.reply) fail("AI 未返回有效发言内容");
  const segment = { id: crypto.randomUUID(), at: Date.now(), channel: "ai", speaker: "AI 参谋", text: parsed.reply, points: Array.isArray(parsed.points) ? parsed.points : [], instruction, ...(joinMode ? { auto: true } : {}) };
  await withMeeting(meetingId, (m) => ({ ...m, segments: [...m.segments, segment] }));
  emit({ state: "succeeded", meetingId, segment, mode: joinMode ? "join" : "invite", latencyMs: 0 });
}

/* ---------------- AI 推荐快捷话术（只生成文本，不写入会议） ---------------- */

const SUGGEST_PHRASE_COUNT = 6;

/** 根据会议背景与最近发言，推荐一批「邀请 AI 发言」的快捷指令。
 *  只返回话术文本供输入框使用，不生成发言、不写会议时间线。 */
async function suggestPhrases(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  if (!meetingId) fail("缺少 meetingId：请先创建或选择会议");
  const meetings = await loadMeetings();
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) fail(`会议不存在：${meetingId}`);
  const exclude = Array.isArray(stdin.exclude)
    ? [...new Set(stdin.exclude.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, 30)
    : [];
  const role = env("RUODAO_MEETING_ROLE") || "资深会议参谋";
  const recent = transcriptText(meeting, 30);
  const contextLines = [
    `【会议标题】${meeting.title || "未命名会议"}`,
    meeting.context ? `【会议背景】${meeting.context}` : "",
    meeting.participants ? `【参会人】${meeting.participants}` : "",
    meeting.customer ? `【客户】${meeting.customer}` : "",
    recent ? `【最近发言】\n${recent}` : "【最近发言】（暂无转写，请根据会议标题与背景推断）",
  ].filter(Boolean);
  const content = await chatJson([
    {
      role: "system",
      content: `你是${role}，正在列席一场会议。请结合会议上下文，推荐 ${SUGGEST_PHRASE_COUNT} 条接下来最值得让 AI 参谋插话的快捷话术。要求：每条都针对当前会议的具体内容，避免空泛；label 是 2-8 个汉字的短标签，instruction 是点击后填入输入框的完整指令（20-60 字，可直接发送）。${exclude.length ? `不要重复这些已有话术：${exclude.join("、")}。` : ""}只输出一个 JSON 对象：{"phrases":[{"label":"...","instruction":"..."}]}`,
    },
    { role: "user", content: contextLines.join("\n") },
  ], 800);
  const parsed = parseJsonLoose(content) ?? {};
  const rawList = Array.isArray(parsed.phrases) ? parsed.phrases : [];
  const seen = new Set();
  const phrases = [];
  for (const item of rawList) {
    const label = String(item?.label ?? "").replace(/^[\s\d.、]+/, "").trim().slice(0, 12);
    const instruction = String(item?.instruction ?? "").replace(/^[\s\d.、]+/, "").trim().slice(0, 100);
    if (!label || !instruction) continue;
    if (exclude.includes(label) || seen.has(label) || seen.has(instruction)) continue;
    seen.add(label);
    seen.add(instruction);
    phrases.push({ label, instruction });
    if (phrases.length >= SUGGEST_PHRASE_COUNT) break;
  }
  if (!phrases.length) fail("AI 没有返回可用话术，请再试一次");
  emit({ state: "succeeded", meetingId, phrases, generatedAt: Date.now() });
}

/* ---------------- AI 发言质量反馈（只落本地 session） ---------------- */

const FEEDBACK_VALUES = new Set(["useful", "increment", "junk", "useless"]);

/** 给 AI 发言打质量标记：useful=有用 / increment=有增量 / junk=废话 / useless=没用。只写入本地会议数据。 */
async function segmentFeedback(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  const segmentId = (stdin.segmentId || "").trim();
  const feedback = String(stdin.feedback ?? "").trim();
  if (!meetingId || !segmentId) fail("缺少 meetingId / segmentId");
  if (!FEEDBACK_VALUES.has(feedback)) fail(`无效的 feedback：${feedback}（可用 useful / increment / junk / useless）`);
  const meeting = await withMeeting(meetingId, (m) => {
    const segment = m.segments.find((item) => item.id === segmentId);
    if (!segment) fail(`发言不存在：${segmentId}`);
    segment.feedback = segment.feedback === feedback ? "" : feedback; // 再点一次取消
    return m;
  });
  const updated = meeting.segments.find((item) => item.id === segmentId);
  emit({ state: "succeeded", meetingId, segmentId, feedback: updated?.feedback ?? "" });
}

/* ---------------- 商用记忆：起草 → 人工确认入库 → 拼进 AI 提示词 ---------------- */

/** 用 LLM 从本场会议起草客户记忆（不直接生效，等人工确认）。 */
async function memoryDraft(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  if (!meetingId) fail("缺少 meetingId");
  const meetings = await loadMeetings();
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) fail(`会议不存在：${meetingId}`);
  if (!meeting.segments.length) fail("当前会议没有转写内容，无法起草记忆");
  const existing = await loadMemory();
  const known = memoryPromptBlock(existing, meeting.customer);
  const content = await chatJson([
    { role: "system", content: `你是客户记忆整理助手。根据会议逐字稿总结值得长期记住的信息：客户偏好、业务背景、承诺与待办、注意事项。${known ? "已有记忆如下，只补充新信息，不要重复。" : ""}每条一句话、具体可复用。只输出一个 JSON 对象：{"memories":["...","..."],"customer":"客户名（逐字稿未明确则留空）"}` },
    { role: "user", content: `【会议标题】${meeting.title}\n${meeting.customer ? `【客户】${meeting.customer}\n` : ""}【逐字稿】\n${transcriptText(meeting, 200)}` },
  ], 800);
  const parsed = parseJsonLoose(content) ?? {};
  const list = (Array.isArray(parsed.memories) ? parsed.memories : [String(parsed.memories ?? content)])
    .map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
  if (!list.length) fail("AI 没有总结出可入库的记忆");
  const customer = String(parsed.customer ?? "").trim() || meeting.customer || "";
  const drafts = list.map((text) => ({
    id: crypto.randomUUID(),
    customer,
    text,
    status: "pending",
    meetingId,
    meetingTitle: meeting.title,
    createdAt: Date.now(),
  }));
  const memory = await loadMemory();
  memory.push(...drafts);
  await saveMemory(memory);
  emit({ state: "succeeded", meetingId, customer, drafts });
}

/** 人工确认入库（可先编辑 text / customer），或丢弃草稿。 */
async function memoryConfirm(stdin) {
  const id = (stdin.id || "").trim();
  if (!id) fail("缺少记忆 id");
  const memory = await loadMemory();
  const entry = memory.find((item) => item.id === id);
  if (!entry) fail(`记忆不存在：${id}`);
  if (stdin.discard) {
    await saveMemory(memory.filter((item) => item.id !== id));
    emit({ state: "succeeded", id, discarded: true });
    return;
  }
  if (typeof stdin.text === "string" && stdin.text.trim()) entry.text = stdin.text.trim();
  if (typeof stdin.customer === "string") entry.customer = stdin.customer.trim();
  entry.status = "confirmed";
  entry.confirmedAt = Date.now();
  await saveMemory(memory);
  emit({ state: "succeeded", id, entry });
}

/** 记忆列表（含待确认草稿），供 UI 展示。 */
async function memoryList() {
  const memory = await loadMemory();
  emit({ state: "succeeded", entries: memory.slice().reverse() });
}

/* ---------------- 会后纪要 ---------------- */

async function generateMinutes(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  if (!meetingId) fail("缺少 meetingId：请先创建或选择会议");
  const meetings = await loadMeetings();
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) fail(`会议不存在：${meetingId}`);
  if (!meeting.segments.length) fail("当前会议没有任何转写内容，无法生成纪要");
  const context = meeting.context ? `会议背景：${meeting.context}\n` : "";
  const roster = meeting.speakers.length
    ? `发言人物：${meeting.speakers.map((speaker) => `${speaker.name}（${speaker.segmentCount} 句）`).join("、")}\n`
    : "";
  const participants = meeting.participants ? `参会人：${meeting.participants}\n` : "";
  const memoryBlock = memoryPromptBlock(await loadMemory(), meeting.customer);
  const content = await chatJson([
    { role: "system", content: `你是专业的会议纪要撰写助手。根据逐字稿生成结构化中文会议纪要，Markdown 格式，包含：一、会议概要；二、主要讨论内容（按议题分节，标注主要发言人和观点）；三、结论与决议；四、待办事项（含负责人，优先使用逐字稿中的真实姓名或说话人名，未知则标「待确认」）；五、风险与遗留问题。不要编造逐字稿中不存在的信息。${memoryBlock}` },
    { role: "user", content: `${context}${participants}${roster}【会议「${meeting.title}」逐字稿】\n${transcriptText(meeting, 300)}` },
  ], 3000);
  const minutes = content.replace(/^```(?:markdown)?|```$/g, "").trim();
  const meeting0 = await withMeeting(meetingId, (m) => syncSpeakers({ ...m, minutes, minutesAt: Date.now() }));
  emit({ state: "succeeded", meetingId, minutes, meeting: meetingSummary(meeting0) });
}

/* ---------------- 文件转写 ---------------- */

async function transcribeFile(stdin) {
  const filePath = (stdin.filePath || "").trim().replace(/^"|"$/g, "");
  if (!filePath) fail("缺少 filePath：请填写本地录音文件完整路径（wav/mp3/m4a 等）");
  if (!existsSync(filePath)) fail(`文件不存在：${filePath}`);
  const sttEp = sttEndpoint();
  if (sttEp.channel === "cloud" && !sttEp.base && sttEp.preset !== "volc") {
    fail(`云端文件转写缺少配置：${sttEp.missing}`);
  }
  if (sttEp.preset === "volc" && (!sttEp.appId || !sttEp.accessKey)) fail(sttEp.missing);
  const stat = (await import("node:fs/promises")).stat;
  const info = await stat(filePath);
  if (info.size > 200 * 1024 * 1024) fail(`文件过大（${Math.round(info.size / 1024 / 1024)}MB），上限 200MB；请先切分音频`);
  const buf = await readFile(filePath);
  const text = await transcribeWav(buf);
  if (!text) fail("未能从该音频中识别出语音内容");
  const title = (stdin.title || "").trim() || path.basename(filePath);
  const meetingId = crypto.randomUUID();
  const savedAudio = path.join(recordingsDir(meetingId), `source-${path.basename(filePath)}`);
  await mkdir(recordingsDir(meetingId), { recursive: true });
  await writeFile(savedAudio, buf);
  const stats = wavStats(buf);
  const durationMs = stats ? Math.round(stats.seconds * 1000) : 0;
  const createdAt = Date.now();
  const meeting = normalizeMeeting({
    id: meetingId,
    title,
    context: (stdin.context ?? env("RUODAO_MEETING_CONTEXT") ?? "").trim(),
    status: "ended",
    source: "file",
    engine: sttChannel(),
    durationMs,
    createdAt,
    endedAt: createdAt + durationMs,
    segments: [{
      id: crypto.randomUUID(), at: createdAt, startMs: 0, endMs: durationMs,
      channel: "file", speakerId: "file", speaker: "录音文件", text, audioPath: savedAudio,
    }],
    speakers: [],
    minutes: "",
  });
  const meetings = await loadMeetings();
  meetings.push(meeting);
  await saveMeetings(meetings);
  emit({ state: "succeeded", meeting, textLength: text.length, channel: sttChannel() });
}

/* ---------------- 导入文件转写结果（宿主完成本机/云端 + 说话人分离） ---------------- */

/** 宿主 meeting:file-transcribe 返回逐句时间轴 + speakerId，本命令负责落成一条会议记录：
 *  源文件复制进会议录音目录、时间轴换算成绝对时间、声纹编号 S1/S2 默认命名为「发言人 N」。 */
async function importTranscript(stdin) {
  const incoming = Array.isArray(stdin.segments) ? stdin.segments : [];
  const cleaned = incoming
    .map((segment) => ({
      startMs: Math.max(0, Number(segment.startMs) || 0),
      endMs: Math.max(0, Number(segment.endMs) || Number(segment.startMs) || 0),
      speakerId: String(segment.speakerId ?? "").trim(),
      text: String(segment.text ?? "").trim(),
    }))
    .filter((segment) => segment.text);
  if (!cleaned.length) fail("缺少 segments：没有可导入的转写句子");

  const fileName = String(stdin.fileName ?? "").trim();
  const title = String(stdin.title ?? "").trim() || fileName || `录音转写 ${new Date().toLocaleString("zh-CN")}`;
  const meetingId = crypto.randomUUID();
  const createdAt = Date.now();
  const sourcePath = String(stdin.sourcePath ?? "").trim();

  let savedAudio = "";
  if (sourcePath && existsSync(sourcePath)) {
    try {
      await mkdir(recordingsDir(meetingId), { recursive: true });
      const safeName = path.basename(sourcePath).replace(/[\\/:*?"<>|]/g, "_");
      savedAudio = path.join(recordingsDir(meetingId), `source-${safeName}`);
      await copyFile(sourcePath, savedAudio);
    } catch { savedAudio = ""; }
  }

  const durationMs = Math.max(
    Number(stdin.durationMs) || 0,
    cleaned.reduce((max, segment) => Math.max(max, segment.endMs), 0),
  );
  const segments = cleaned.map((segment) => {
    const speakerId = segment.speakerId || "file";
    return {
      id: crypto.randomUUID(),
      at: createdAt + segment.startMs,
      startMs: segment.startMs,
      endMs: segment.endMs,
      channel: "file",
      speakerId,
      speaker: defaultSpeakerName(speakerId),
      text: segment.text,
      audioPath: savedAudio || undefined,
    };
  });
  const meeting = normalizeMeeting({
    id: meetingId,
    title,
    context: String(stdin.context ?? env("RUODAO_MEETING_CONTEXT") ?? "").trim(),
    status: "ended",
    source: "file",
    engine: String(stdin.engine ?? "").trim(),
    model: String(stdin.model ?? "").trim(),
    durationMs,
    createdAt,
    endedAt: createdAt + durationMs,
    segments,
    speakers: [],
    minutes: "",
  });
  const meetings = await loadMeetings();
  meetings.push(meeting);
  await saveMeetings(meetings);
  emit({ state: "succeeded", meeting, meetingSummary: meetingSummary(meeting) });
}

/* ---------------- 导出 Markdown ---------------- */

function formatOffset(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function meetingExport(stdin) {
  const meetings = await loadMeetings();
  const meeting = meetings.find((m) => m.id === (stdin.id || "").trim());
  if (!meeting) fail(`会议不存在：${stdin.id}`);
  const durationMs = meetingDurationMs(meeting);
  const lines = [
    `# ${meeting.title}`,
    "",
    `- 时间：${new Date(meeting.createdAt).toLocaleString("zh-CN")}${meeting.endedAt ? ` ~ ${new Date(meeting.endedAt).toLocaleTimeString("zh-CN")}` : ""}`,
    `- 时长：${formatOffset(durationMs)}`,
    `- 来源：${meeting.source === "file" ? "录音文件转写" : "实时会议"}${meeting.engine ? `（${meeting.engine}）` : ""}`,
    meeting.context ? `- 会议背景：${meeting.context}` : "",
    meeting.speakers.length ? `- 发言人：${meeting.speakers.map((speaker) => `${speaker.name}（${speaker.segmentCount} 句）`).join("、")}` : "",
    "",
    "## 逐字稿",
    "",
    ...meeting.segments.map((segment) => {
      const offset = segment.startMs != null ? segment.startMs : Number(segment.at) - Number(meeting.createdAt);
      const points = Array.isArray(segment.points) && segment.points.length ? `\n${segment.points.map((point) => `  - ${point}`).join("\n")}` : "";
      return `**${formatOffset(offset)} ${segment.speaker}**：${segment.text}${points}`;
    }),
    "",
  ];
  if (meeting.minutes) lines.push(meeting.minutes);
  const safeName = meeting.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  const file = path.join(dataDir(), `${safeName}-${meeting.id.slice(0, 8)}.md`);
  await mkdir(dataDir(), { recursive: true });
  await writeFile(file, `${lines.join("\n").trim()}\n`, "utf8");
  emit({ state: "succeeded", file, meeting: meetingSummary(meeting) });
}

/* ---------------- 追加流式句子（宿主听写通道产出） ---------------- */

/** 宿主流式听写（plugins:meeting-listen-poll）产出的句子经本命令写回会议时间线。
 *  句子文本已由宿主完成云端精转写，这里只做持久化：补 id/at、按通道定说话人。 */
async function appendSegments(stdin) {
  const meetingId = (stdin.meetingId || "").trim();
  if (!meetingId) fail("缺少 meetingId：请先创建或选择会议");
  const incoming = Array.isArray(stdin.segments) ? stdin.segments : [];
  if (!incoming.length) fail("缺少 segments：没有可写入的句子");
  const speakerByChannel = { mic: "我方", system: "会议方", ai: "AI 参谋", file: "录音文件" };
  const defaultIdByChannel = { mic: "self", system: "remote", ai: "ai", file: "file" };
  const segments = incoming
    .filter((s) => s && String(s.text ?? "").trim())
    .map((s) => {
      const channel = String(s.channel ?? "mic").trim() || "mic";
      const speakerId = String(s.speakerId ?? "").trim() || defaultIdByChannel[channel] || channel;
      const startMs = Number.isFinite(Number(s.startMs)) ? Math.max(0, Number(s.startMs)) : undefined;
      const endMs = Number.isFinite(Number(s.endMs)) ? Math.max(0, Number(s.endMs)) : undefined;
      return {
        id: crypto.randomUUID(),
        at: Number(s.at) || Date.now(),
        channel,
        speakerId,
        speaker: String(s.speaker ?? "").trim() || defaultSpeakerName(speakerId) || speakerByChannel[channel] || channel,
        text: String(s.text).trim(),
        audioPath: s.audioPath ? String(s.audioPath) : undefined,
        ...(startMs != null ? { startMs: startMs } : {}),
        ...(endMs != null ? { endMs: endMs } : {}),
      };
    });
  if (!segments.length) fail("segments 里没有有效句子（text 全为空）");
  const meeting = await withMeeting(meetingId, (m) => syncSpeakers({ ...m, segments: [...m.segments, ...segments] }));
  emit({ state: "succeeded", meetingId, segments, segmentCount: meeting.segments.length, speakers: meeting.speakers });
}

/* ---------------- 会议知识库（P0-P2：智能抽取 / 问题台账 / 问答 / 周期报告 / 遗留跟踪） ---------------- */

function knowledgeOverridesFile() {
  return path.join(dataDir(), "knowledge-overrides.json");
}

async function loadKnowledgeOverrides() {
  const file = knowledgeOverridesFile();
  if (!existsSync(file)) return { status: {}, note: {}, hidden: [] };
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return {
      status: data?.status && typeof data.status === "object" ? data.status : {},
      note: data?.note && typeof data.note === "object" ? data.note : {},
      hidden: Array.isArray(data?.hidden) ? data.hidden : [],
    };
  }
  catch { return { status: {}, note: {}, hidden: [] }; }
}

async function saveKnowledgeOverrides(overrides) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(knowledgeOverridesFile(), JSON.stringify(overrides, null, 2), "utf8");
}

function normKeyText(text) {
  return String(text || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function issueKey(text) {
  return crypto.createHash("md5").update(normKeyText(text)).digest("hex").slice(0, 12);
}

function bigramsOf(text) {
  const s = normKeyText(text);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 双字 bigram 相似度：jaccard 与包含度混合——中文短句变体（补了"仍未"、去掉尾缀）也能并上，零依赖。 */
function textSimilarity(a, b) {
  const A = bigramsOf(a);
  const B = bigramsOf(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const gram of A) if (B.has(gram)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return (jaccard + containment) / 2;
}

const ISSUE_SIMILAR_THRESHOLD = 0.42;

/** 把所有会议的 knowledge 抽取结果摊平成台账：跨会议相似问题自动合并，人工覆写最后生效。 */
function flattenKnowledge(meetings, overrides) {
  const chrono = meetings.slice().sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  const issues = [];
  const decisions = [];
  const actions = [];
  for (const meeting of chrono) {
    const k = meeting.knowledge;
    if (!k || typeof k !== "object") continue;
    const ref = { id: meeting.id, title: meeting.title, at: Number(meeting.createdAt) || 0 };
    for (const item of (Array.isArray(k.issues) ? k.issues : [])) {
      const text = String(item?.text ?? "").trim();
      if (!text) continue;
      const status = ["open", "resolved", "deferred"].includes(String(item?.status)) ? String(item.status) : "open";
      const note = String(item?.note ?? "").trim();
      const hit = issues.find((entry) => textSimilarity(entry.text, text) >= ISSUE_SIMILAR_THRESHOLD);
      if (hit) {
        hit.meetings.push(ref);
        hit.lastAt = Math.max(hit.lastAt, ref.at);
        if (ref.at >= hit.lastStatusAt) { hit.lastStatusAt = ref.at; hit.status = status; if (note) hit.note = note; if (text.length > hit.text.length) hit.text = text; }
      } else {
        issues.push({ key: issueKey(text), text, status, note, firstAt: ref.at, lastStatusAt: ref.at, lastAt: ref.at, meetings: [ref] });
      }
    }
    for (const item of (Array.isArray(k.decisions) ? k.decisions : [])) {
      const text = String(item?.text ?? item ?? "").trim();
      if (!text) continue;
      const hit = decisions.find((entry) => textSimilarity(entry.text, text) >= ISSUE_SIMILAR_THRESHOLD);
      if (hit) { if (text.length > hit.text.length) hit.text = text; hit.meetings.push(ref); hit.lastAt = Math.max(hit.lastAt, ref.at); }
      else decisions.push({ key: issueKey(text), text, firstAt: ref.at, lastAt: ref.at, meetings: [ref] });
    }
    for (const item of (Array.isArray(k.actions) ? k.actions : [])) {
      const text = String(item?.text ?? item ?? "").trim();
      if (!text) continue;
      const owner = String(item?.owner ?? "").trim();
      const due = String(item?.due ?? "").trim();
      const hit = actions.find((entry) => textSimilarity(entry.text, text) >= ISSUE_SIMILAR_THRESHOLD);
      if (hit) { if (text.length > hit.text.length) hit.text = text; if (owner) hit.owner = owner; if (due) hit.due = due; hit.meetings.push(ref); hit.lastAt = Math.max(hit.lastAt, ref.at); }
      else actions.push({ key: issueKey(text), text, owner, due, firstAt: ref.at, lastAt: ref.at, meetings: [ref] });
    }
  }
  // 人工覆写最后生效：改状态 / 改备注 / 隐藏误抽取条目
  for (const list of [issues]) {
    for (const entry of list) {
      const patch = overrides.status[entry.key];
      if (patch && ["open", "resolved", "deferred"].includes(patch)) entry.status = patch;
      const note = overrides.note[entry.key];
      if (note) entry.note = note;
      entry.manual = Boolean(patch || note);
    }
  }
  const hidden = new Set(overrides.hidden);
  const daysOf = (ts) => Math.max(0, Math.floor((Date.now() - ts) / 86400000));
  const issueView = issues.filter((entry) => !hidden.has(entry.key))
    .map((entry) => ({ ...entry, daysOpen: daysOf(entry.firstAt), daysStale: daysOf(entry.lastAt), meetings: entry.meetings.slice(-10) }))
    .sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.daysOpen - a.daysOpen);
  const decisionView = decisions.filter((entry) => !hidden.has(entry.key)).map((entry) => ({ ...entry, meetings: entry.meetings.slice(-10) })).sort((a, b) => b.lastAt - a.lastAt);
  const actionView = actions.filter((entry) => !hidden.has(entry.key)).map((entry) => ({ ...entry, meetings: entry.meetings.slice(-10) })).sort((a, b) => b.lastAt - a.lastAt);
  const stats = {
    meetingsCovered: chrono.filter((m) => m.knowledge).length,
    meetingsTotal: chrono.length,
    issuesOpen: issueView.filter((entry) => entry.status === "open").length,
    issuesResolved: issueView.filter((entry) => entry.status === "resolved").length,
    issuesDeferred: issueView.filter((entry) => entry.status === "deferred").length,
    actionsPending: actionView.length,
    decisionsTotal: decisionView.length,
    oldestOpenDays: issueView.filter((entry) => entry.status === "open").reduce((max, entry) => Math.max(max, entry.daysOpen), 0),
  };
  return { issues: issueView, decisions: decisionView, actions: actionView, stats };
}

async function knowledgeExtract(stdin) {
  const meetings = await loadMeetings();
  const meetingId = (stdin.meetingId || "").trim();
  const targets = meetingId
    ? meetings.filter((m) => m.id === meetingId)
    : stdin.all === true || stdin.all === "true"
      ? meetings.filter((m) => m.segments.length && !m.knowledge)
      : [];
  if (!targets.length) {
    if (meetingId) fail(`会议不存在：${meetingId}`);
    emit({ state: "succeeded", extracted: 0, skipped: 0, message: "所有会议都已抽取过，无需重建知识索引" });
    return;
  }
  const results = [];
  let lastError = "";
  for (const meeting of targets) {
    if (!meeting.segments.length) { results.push({ meetingId: meeting.id, title: meeting.title, skipped: true }); continue; }
    const context = meeting.context ? `会议背景：${meeting.context}\n` : "";
    const roster = meeting.speakers.length ? `发言人：${meeting.speakers.map((s) => s.name).join("、")}\n` : "";
    try {
      const raw = await chatJson([
        { role: "system", content: `你是会议知识抽取引擎。从逐字稿中严格按事实抽取，输出 JSON：{"topics":["议题"],"decisions":["达成的决定/结论"],"issues":[{"text":"提出的问题或难题","status":"open|resolved|deferred","note":"一句话现状"}],"actions":[{"text":"待办事项","owner":"负责人或待确认","due":"截止时间或空"}]}。规则：只提取逐字稿中真实出现的内容，不编造；问题包括明确的疑问、风险、卡点、"下次再议"的悬而未决事项；讨论中已给出结论的问题 status 用 resolved；明确推迟的用 deferred。无内容的数组留空。` },
        { role: "user", content: `${context}${roster}【会议「${meeting.title}」逐字稿】\n${transcriptText(meeting, 300)}` },
      ], 2000);
      const parsed = parseJsonLoose(raw);
      if (!parsed) throw new Error("AI 未返回有效 JSON");
      const knowledge = {
        extractedAt: Date.now(),
        topics: (Array.isArray(parsed.topics) ? parsed.topics : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20),
        decisions: (Array.isArray(parsed.decisions) ? parsed.decisions : []).map((t) => ({ text: String(typeof t === "string" ? t : t?.text ?? "").trim() })).filter((t) => t.text).slice(0, 30),
        issues: (Array.isArray(parsed.issues) ? parsed.issues : []).map((t) => ({ text: String(t?.text ?? "").trim(), status: ["open", "resolved", "deferred"].includes(String(t?.status)) ? String(t.status) : "open", note: String(t?.note ?? "").trim() })).filter((t) => t.text).slice(0, 40),
        actions: (Array.isArray(parsed.actions) ? parsed.actions : []).map((t) => ({ text: String(t?.text ?? "").trim(), owner: String(t?.owner ?? "").trim(), due: String(t?.due ?? "").trim() })).filter((t) => t.text).slice(0, 30),
      };
      const saved = await withMeeting(meeting.id, (m) => ({ ...m, knowledge }));
      results.push({ meetingId: meeting.id, title: meeting.title, topics: knowledge.topics.length, decisions: knowledge.decisions.length, issues: knowledge.issues.length, actions: knowledge.actions.length, extractedAt: saved.knowledge.extractedAt });
    } catch (error) {
      lastError = String(error?.message ?? error);
      results.push({ meetingId: meeting.id, title: meeting.title, error: lastError });
    }
  }
  const okCount = results.filter((r) => !r.error && !r.skipped).length;
  if (!okCount && lastError && targets.length === 1) fail(`知识抽取失败：${lastError}`);
  emit({ state: "succeeded", extracted: okCount, skipped: results.length - okCount, results });
}

function filterLedgerByQuery(ledger, query) {
  const q = String(query ?? "").trim();
  if (!q) return ledger;
  const grams = [...bigramsOf(q)];
  const scoreOf = (text) => {
    const grams2 = [...bigramsOf(text)];
    if (!grams.length || !grams2.length) return normKeyText(text).includes(normKeyText(q)) ? 1 : 0;
    let hit = 0;
    for (const g of grams) if (grams2.includes(g)) hit++;
    return hit / grams.length;
  };
  return {
    ...ledger,
    issues: ledger.issues.filter((entry) => scoreOf(entry.text) >= 0.25 || entry.status === q),
    decisions: ledger.decisions.filter((entry) => scoreOf(entry.text) >= 0.25),
    actions: ledger.actions.filter((entry) => scoreOf(entry.text) >= 0.25 || scoreOf(entry.owner) >= 0.5),
  };
}

function knowledgeLedger(stdin) {
  return (async () => {
    const meetings = await loadMeetings();
    const overrides = await loadKnowledgeOverrides();
    const ledger = filterLedgerByQuery(flattenKnowledge(meetings, overrides), stdin.q);
    emit({ state: "succeeded", dataDir: dataDir(), ...ledger });
  })();
}

async function knowledgeIssueUpdate(stdin) {
  const key = (stdin.key || "").trim();
  if (!key) fail("缺少 key：请传入台账条目的 key");
  const overrides = await loadKnowledgeOverrides();
  const status = (stdin.status || "").trim();
  if (status) {
    if (!["open", "resolved", "deferred"].includes(status)) fail(`非法状态：${status}（open / resolved / deferred）`);
    overrides.status[key] = status;
  }
  if (stdin.hidden === true) overrides.hidden.push(key);
  if (typeof stdin.note === "string") {
    if (stdin.note.trim()) overrides.note[key] = stdin.note.trim();
    else delete overrides.note[key];
  }
  await saveKnowledgeOverrides(overrides);
  const meetings = await loadMeetings();
  const ledger = flattenKnowledge(meetings, overrides);
  emit({ state: "succeeded", key, ...ledger });
}

/** 简单关键词检索：问题分词（拉丁词 + 中文字 bigram）对逐字稿句子打分。 */
function questionTerms(question) {
  const terms = new Set();
  for (const word of String(question || "").toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []) terms.add(word);
  const cjk = String(question || "").replace(/[^\u4e00-\u9fff]/g, "");
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk.slice(i, i + 2));
  for (const ch of cjk) if (cjk.length <= 4) terms.add(ch);
  return [...terms];
}

async function knowledgeAsk(stdin) {
  const question = (stdin.question || "").trim();
  if (!question) fail("缺少 question：请输入你想问的问题");
  const days = Math.min(Math.max(Number(stdin.days) || 180, 7), 3650);
  const since = Date.now() - days * 86400000;
  const meetings = (await loadMeetings()).filter((m) => (Number(m.createdAt) || 0) >= since);
  if (!meetings.length) fail(`最近 ${days} 天没有会议记录，先开会或调整时间范围`);
  const terms = questionTerms(question);
  if (!terms.length) fail("问题太短，请多写几个字方便检索");
  const scored = [];
  for (const meeting of meetings) {
    for (const segment of meeting.segments) {
      const text = String(segment.text || "");
      if (!text) continue;
      const hay = normKeyText(text);
      let hit = 0;
      for (const term of terms) if (hay.includes(normKeyText(term))) hit++;
      if (hit > 0) scored.push({ meeting, segment, hit });
    }
  }
  scored.sort((a, b) => b.hit - a.hit || (b.segment.at || 0) - (a.segment.at || 0));
  const top = scored.slice(0, 40);
  const ledger = filterLedgerByQuery(flattenKnowledge(meetings, await loadKnowledgeOverrides()), question);
  const ledgerLines = [
    ...ledger.issues.slice(0, 8).map((entry) => `- [问题·${entry.status === "open" ? "未解决" : entry.status === "resolved" ? "已解决" : "已搁置"}] ${entry.text}（提出于 ${new Date(entry.firstAt).toLocaleDateString("zh-CN")}，讨论过 ${entry.meetings.length} 次）`),
    ...ledger.decisions.slice(0, 6).map((entry) => `- [决定] ${entry.text}（${new Date(entry.firstAt).toLocaleDateString("zh-CN")}）`),
  ].join("\n");
  const contextBlocks = top.slice(0, 30).map((entry, index) => {
    const date = new Date(entry.meeting.createdAt).toLocaleDateString("zh-CN");
    const speaker = entry.segment.speaker || "某人";
    return `[${index + 1}] 会议「${entry.meeting.title}」(${date}) ${speaker}：${entry.segment.text}`;
  });
  const prompt = [
    `【知识库台账摘要】\n${ledgerLines || "（无匹配条目）"}`,
    `【逐字稿相关片段（按相关度排序）】\n${contextBlocks.join("\n") || "（无匹配片段）"}`,
  ].join("\n\n");
  const answer = await chatJson([
    { role: "system", content: `你是企业会议知识库问答助手。只依据提供的材料回答，用中文 Markdown；引用材料时在句尾标注 [编号]；材料不足以回答时明确说明"知识库中没有找到相关记录"，并给出最接近的信息。不要编造。` },
    { role: "user", content: `【问题】${question}\n\n${prompt}` },
  ], 2000);
  const sources = top.slice(0, 8).map((entry, index) => ({
    index: index + 1,
    meetingId: entry.meeting.id,
    title: entry.meeting.title,
    at: entry.segment.at,
    speaker: entry.segment.speaker || "",
    text: String(entry.segment.text || "").slice(0, 200),
  }));
  emit({ state: "succeeded", question, answer: answer.trim(), sources, searchedMeetings: meetings.length, searchedDays: days });
}

async function knowledgeReport(stdin) {
  const days = Math.min(Math.max(Number(stdin.days) || 30, 1), 3650);
  const since = Date.now() - days * 86400000;
  const meetings = (await loadMeetings()).filter((m) => (Number(m.createdAt) || 0) >= since);
  if (!meetings.length) fail(`最近 ${days} 天没有会议记录`);
  const missing = meetings.filter((m) => m.segments.length && !m.knowledge);
  if (missing.length) {
    // 自动补齐缺失的知识抽取，再出报告（受 command 超时保护，单场约 10-20 秒）
    for (const meeting of missing.slice(0, 12)) {
      try { await knowledgeExtract({ meetingId: meeting.id }); } catch { /* 单场失败不阻塞报告 */ }
    }
  }
  const refreshed = (await loadMeetings()).filter((m) => (Number(m.createdAt) || 0) >= since);
  const ledger = flattenKnowledge(refreshed, await loadKnowledgeOverrides());
  const meetingLines = refreshed.slice().reverse().map((m) => {
    const k = m.knowledge;
    const topics = k && Array.isArray(k.topics) ? k.topics.slice(0, 5).join("、") : "";
    return `- ${new Date(m.createdAt).toLocaleDateString("zh-CN")}「${m.title}」${m.customer ? `（客户：${m.customer}）` : ""}${topics ? `：${topics}` : ""}`;
  }).join("\n");
  const issueLines = ledger.issues.map((entry) => `- [${entry.status === "open" ? "未解决" : entry.status === "resolved" ? "已解决" : "已搁置"}] ${entry.text}（首提 ${new Date(entry.firstAt).toLocaleDateString("zh-CN")}，挂起 ${entry.daysOpen} 天，讨论 ${entry.meetings.length} 次${entry.note ? `；现状：${entry.note}` : ""}）`).join("\n");
  const decisionLines = ledger.decisions.slice(0, 40).map((entry) => `- ${entry.text}（${new Date(entry.firstAt).toLocaleDateString("zh-CN")}）`).join("\n");
  const actionLines = ledger.actions.slice(0, 40).map((entry) => `- ${entry.text}${entry.owner ? `（负责人：${entry.owner}` : "（负责人：待确认"}${entry.due ? `，截止：${entry.due}` : ""}）`).join("\n");
  const markdown = await chatJson([
    { role: "system", content: `你是企业会议知识库分析助手。基于给定材料撰写一份中文 Markdown 周期报告（不要编造材料之外的内容），包含以下小节：\n## 一、本阶段会议概览\n## 二、做出哪些决定\n## 三、解决了哪些问题\n## 四、仍未解决的难题（按挂起时间排序，逐条给出卡点分析与推进建议）\n## 五、待办与责任落实\n## 六、风险与建议\n语言精炼、面向管理者。` },
    { role: "user", content: `【统计】时间范围：最近 ${days} 天；会议 ${refreshed.length} 场；未解决问题 ${ledger.stats.issuesOpen} 个（最长挂起 ${ledger.stats.oldestOpenDays} 天）；已解决 ${ledger.stats.issuesResolved} 个；决定 ${ledger.stats.decisionsTotal} 条；待办 ${ledger.stats.actionsPending} 条。\n\n【会议列表】\n${meetingLines || "（无）"}\n\n【问题台账】\n${issueLines || "（无）"}\n\n【决定】\n${decisionLines || "（无）"}\n\n【待办】\n${actionLines || "（无）"}` },
  ], 3000);
  emit({ state: "succeeded", days, stats: ledger.stats, markdown: markdown.replace(/^```(?:markdown)?|```$/g, "").trim() });
}



const stdin = await readStdin();
// 工作台 UI 通过 stdin JSON 的 config 字段传入配置，覆盖同名环境变量。
if (stdin.config && typeof stdin.config === "object") {
  for (const [key, value] of Object.entries(stdin.config)) {
    if (/^RUODAO_[A-Z0-9_]+$/.test(key) && value != null && String(value).trim()) process.env[key] = String(value).trim();
  }
}
const mode = process.argv[2] ?? "";
if (mode === "doctor") await doctor();
else if (mode === "meeting-create") await meetingCreate(stdin);
else if (mode === "meetings-list") await meetingsList();
else if (mode === "meeting-get") await meetingGet(stdin);
else if (mode === "meeting-update") await meetingUpdate(stdin);
else if (mode === "meeting-end") await meetingEnd(stdin);
else if (mode === "meeting-delete") await meetingDelete(stdin);
else if (mode === "meeting-speaker-update") await speakerUpdate(stdin);
else if (mode === "record-segment") await recordSegment(stdin);
else if (mode === "append-segments") await appendSegments(stdin);
else if (mode === "segment-update") await segmentUpdate(stdin);
else if (mode === "segment-delete") await segmentDelete(stdin);
else if (mode === "ai-respond") await aiRespond(stdin);
else if (mode === "suggest-phrases") await suggestPhrases(stdin);
else if (mode === "segment-feedback") await segmentFeedback(stdin);
else if (mode === "memory-draft") await memoryDraft(stdin);
else if (mode === "memory-confirm") await memoryConfirm(stdin);
else if (mode === "memory-list") await memoryList();
else if (mode === "minutes") await generateMinutes(stdin);
else if (mode === "transcribe-file") await transcribeFile(stdin);
else if (mode === "import-transcript") await importTranscript(stdin);
else if (mode === "meeting-export") await meetingExport(stdin);
else if (mode === "knowledge-extract") await knowledgeExtract(stdin);
else if (mode === "knowledge-ledger") await knowledgeLedger(stdin);
else if (mode === "knowledge-issue-update") await knowledgeIssueUpdate(stdin);
else if (mode === "knowledge-ask") await knowledgeAsk(stdin);
else if (mode === "knowledge-report") await knowledgeReport(stdin);
else fail(`未知模式：${mode}（支持 doctor / meeting-create / meetings-list / meeting-get / meeting-update / meeting-end / meeting-delete / meeting-speaker-update / record-segment / append-segments / segment-update / segment-delete / segment-feedback / ai-respond / suggest-phrases / memory-draft / memory-confirm / memory-list / minutes / transcribe-file / import-transcript / meeting-export / knowledge-extract / knowledge-ledger / knowledge-issue-update / knowledge-ask / knowledge-report）`);
