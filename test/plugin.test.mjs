/**
 * 会议助手插件本地验证脚本（零依赖）
 * 覆盖：manifest 结构、doctor、会议 CRUD、AI 参会发言（mock LLM）、错误路径。
 * 运行：node test/plugin.test.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "bin", "meeting-assistant.mjs");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "ruodao-meeting-test-"));
const baseEnv = { RUODAO_MEETING_DATA_DIR: dataDir };

function runPlugin(args, { env = {}, stdin = "{}" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...baseEnv, ...env },
      windowsHide: true,
    });
    let out = "", err = "";
    child.stdin.write(stdin);
    child.stdin.end();
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const llmPort = 18931;
let lastAiPayload = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    assert.match(req.url, /\/chat\/completions/);
    const payload = JSON.parse(body);
    if (payload.messages.some((m) => m.content.includes("快捷话术"))) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        phrases: Array.from({ length: 6 }, (_, index) => ({
          label: index === 0 ? "测试话术" : `追问要点${index}`,
          instruction: `请结合当前讨论追问第 ${index} 个关键问题，并给出判断依据`,
        })),
      }) } }] }));
    } else if (payload.messages.some((m) => m.content.includes("正以参会者身份"))) {
      lastAiPayload = payload;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "同意冻结范围，我补一句：交付节奏建议按双周同步。", points: ["双周同步"] }) } }] }));
    } else if (payload.messages.some((m) => m.content.includes("会议参谋"))) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "我建议先冻结范围再排期。", points: ["冻结范围", "按周排期"] }) } }] }));
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "# 会议纪要\n\n一、会议概要\n…" } }] }));
    }
  });
});
await new Promise((r) => server.listen(llmPort, r));

try {
  // 1. manifest 结构校验
  const manifest = JSON.parse(await readFile(path.join(root, "ruodao-plugin.json"), "utf8"));
  assert.equal(manifest.id, "com.ruodao.meeting-assistant");
  assert.ok(manifest.apiVersion.includes("0.1.0"));
  assert.ok(manifest.contributes.commands.length >= 10);
  for (const cmd of manifest.contributes.commands) {
    assert.equal(cmd.action.type, "process");
    assert.ok(cmd.action.timeoutMs > 0);
  }
  const ui = JSON.parse(await readFile(path.join(root, "ui.json"), "utf8"));
  assert.equal(ui.route, "meeting-assistant");
  console.log("ok manifest + ui");

  // 2. doctor：无配置也应输出合法 JSON 报告
  const doctor = await runPlugin(["doctor"], {});
  assert.equal(doctor.code, 0);
  const report = JSON.parse(doctor.out.trim());
  assert.equal(report.state, "succeeded");
  assert.ok("checks" in report && "ffmpeg" in report.checks && "stt" in report.checks);
  console.log("ok doctor");

  // 3. 会议 CRUD
  const created = await runPlugin(["meeting-create"], { stdin: JSON.stringify({ title: "测试会议", context: "Q4 评审" }) });
  const createdData = JSON.parse(created.out.trim());
  assert.equal(createdData.state, "succeeded");
  const meetingId = createdData.meeting.id;
  assert.equal(createdData.meeting.title, "测试会议");
  const list = JSON.parse((await runPlugin(["meetings-list"], {})).out.trim());
  assert.equal(list.total, 1);
  console.log("ok meeting-create / meetings-list");

  // 4. record-segment 缺设备错误路径
  const noDevice = await runPlugin(["record-segment"], { stdin: JSON.stringify({ meetingId }) });
  assert.equal(noDevice.code, 1);
  assert.match(JSON.parse(noDevice.out.trim()).error, /录音设备/);
  console.log("ok record-segment error path");

  // 5. ai-respond：直接写一段转写进会议，mock LLM 端到端
  const storeFile = path.join(dataDir, "meetings.json");
  const store = JSON.parse(await readFile(storeFile, "utf8"));
  store[0].segments.push({ id: "s1", at: Date.now(), channel: "system", speaker: "会议方", text: "我们希望 Q4 上线，但需求还在变。" });
  await writeFile(storeFile, JSON.stringify(store), "utf8");
  const ai = await runPlugin(["ai-respond"], {
    env: { RUODAO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, RUODAO_LLM_API_KEY: "mock-key", RUODAO_LLM_MODEL: "mock-model" },
    stdin: JSON.stringify({ meetingId, instruction: "你怎么看这个排期？" }),
  });
  const aiData = JSON.parse(ai.out.trim());
  assert.equal(aiData.state, "succeeded");
  assert.equal(aiData.segment.speaker, "AI 参谋");
  assert.match(aiData.segment.text, /冻结范围/);
  console.log("ok ai-respond (mock LLM e2e)");

  // 5a. ai-respond 参会模式：mode:"join" 走参会者提示词，附历史 AI 发言，segment.auto=true
  const join = await runPlugin(["ai-respond"], {
    env: { RUODAO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, RUODAO_LLM_API_KEY: "mock-key", RUODAO_LLM_MODEL: "mock-model" },
    stdin: JSON.stringify({ meetingId, mode: "join" }),
  });
  const joinData = JSON.parse(join.out.trim());
  assert.equal(joinData.state, "succeeded");
  assert.equal(joinData.mode, "join");
  assert.equal(joinData.segment.auto, true);
  assert.match(joinData.segment.text, /双周同步/);
  assert.match(joinData.segment.instruction, /自然接话/);
  assert.ok(lastAiPayload, "join 模式应打到 mock LLM");
  const joinSystem = lastAiPayload.messages.find((m) => m.role === "system").content;
  const joinUser = lastAiPayload.messages.find((m) => m.role === "user").content;
  assert.match(joinSystem, /正以参会者身份/);
  assert.match(joinSystem, /【你之前的发言】/);
  assert.match(joinSystem, /不要重复你之前说过的观点/);
  assert.match(joinUser, /【参会关注点】/);
  assert.match(joinUser, /我们希望 Q4 上线/);
  // 普通邀请模式不带参会者身份与历史发言
  const inviteAgain = await runPlugin(["ai-respond"], {
    env: { RUODAO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, RUODAO_LLM_API_KEY: "mock-key", RUODAO_LLM_MODEL: "mock-model" },
    stdin: JSON.stringify({ meetingId, instruction: "再补充一点" }),
  });
  const inviteAgainData = JSON.parse(inviteAgain.out.trim());
  assert.equal(inviteAgainData.mode, "invite");
  assert.equal(inviteAgainData.segment.auto, undefined);
  assert.match(inviteAgainData.segment.instruction, /再补充一点/);
  console.log("ok ai-respond join mode (mock LLM e2e)");

  // 5b. suggest-phrases：结合会议上下文推荐话术，过滤重复标签，不写入时间线
  const segmentsBeforeSuggest = JSON.parse(await readFile(storeFile, "utf8"))[0].segments.length;
  const suggested = await runPlugin(["suggest-phrases"], {
    env: { RUODAO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, RUODAO_LLM_API_KEY: "mock-key", RUODAO_LLM_MODEL: "mock-model" },
    stdin: JSON.stringify({ meetingId, exclude: ["测试话术"] }),
  });
  const suggestedData = JSON.parse(suggested.out.trim());
  assert.equal(suggestedData.state, "succeeded");
  assert.equal(suggestedData.phrases.length, 5);
  assert.ok(suggestedData.phrases.every((phrase) => phrase.label && phrase.instruction));
  assert.ok(!suggestedData.phrases.some((phrase) => phrase.label === "测试话术"));
  assert.equal(JSON.parse(await readFile(storeFile, "utf8"))[0].segments.length, segmentsBeforeSuggest);
  console.log("ok suggest-phrases (mock LLM e2e, no timeline write)");

  // 6. minutes：mock LLM 端到端
  const minutes = await runPlugin(["minutes"], {
    env: { RUODAO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, RUODAO_LLM_API_KEY: "mock-key", RUODAO_LLM_MODEL: "mock-model" },
    stdin: JSON.stringify({ meetingId }),
  });
  const minutesData = JSON.parse(minutes.out.trim());
  assert.equal(minutesData.state, "succeeded");
  assert.match(minutesData.minutes, /会议纪要/);
  console.log("ok minutes (mock LLM e2e)");

  // 7. export + delete
  const exported = JSON.parse((await runPlugin(["meeting-export"], { stdin: JSON.stringify({ id: meetingId }) })).out.trim());
  assert.equal(exported.state, "succeeded");
  assert.ok(exported.file.endsWith(".md"));
  const deleted = JSON.parse((await runPlugin(["meeting-delete"], { stdin: JSON.stringify({ id: meetingId }) })).out.trim());
  assert.equal(deleted.state, "succeeded");
  const listAfter = JSON.parse((await runPlugin(["meetings-list"], {})).out.trim());
  assert.equal(listAfter.total, 0);
  console.log("ok meeting-export / meeting-delete");

  // 8. transcribe-file：文件不存在错误路径
  const missing = await runPlugin(["transcribe-file"], { stdin: JSON.stringify({ filePath: "Z:/nope.wav" }) });
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.out.trim()).error, /文件不存在/);
  console.log("ok transcribe-file error path");

  console.log("ALL PASS");
} finally {
  server.close();
}
