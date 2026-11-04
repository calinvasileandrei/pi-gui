#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc`, for contract tests and UI dev without a provider.
// Behaviour by prompt text:
//   "crash"      -> exit(3) mid-run
//   "ask"        -> extension_ui_request confirm, then echo the answer
//   "tool"       -> fake bash tool call + result
//   anything else-> streams "echo: <text>" word by word
// Usage: node fake-pi.mjs --mode rpc [...]
import { StringDecoder } from "node:string_decoder";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delay = Number(process.env.FAKE_PI_DELAY ?? 15);

const model = { id: "fake-1", name: "Fake Model", provider: "fake", reasoning: true, contextWindow: 100000, maxTokens: 4096 };
const models = [model, { id: "fake-2", name: "Fake Model 2", provider: "fake", reasoning: false, contextWindow: 50000 }];
let current = model;
let thinking = "medium";
let streaming = false;
let aborted = false;
const messages = [];
const uiWaiters = new Map();
let uiSeq = 0;
let name;

const state = () => ({
  model: current, thinkingLevel: thinking, isStreaming: streaming, isCompacting: false,
  steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", sessionId: "fake-session",
  sessionName: name, autoCompactionEnabled: true, messageCount: messages.length, pendingMessageCount: 0,
});
const ok = (cmd, data) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data !== undefined ? { data } : {}) });
const fail = (cmd, error) => out({ id: cmd.id, type: "response", command: cmd.type, success: false, error });

async function run(text) {
  streaming = true;
  aborted = false;
  const user = { role: "user", content: text, timestamp: Date.now() };
  messages.push(user);
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  out({ type: "message_start", message: user });
  out({ type: "message_end", message: user });

  if (text === "spawn") {
    const { spawn } = await import("node:child_process");
    const c = spawn("sleep", ["30"], { stdio: "ignore" });
    process.stderr.write(`grandchild:${c.pid}\n`);
  }

  if (text === "crash") {
    await sleep(delay);
    process.stderr.write("fake-pi: simulated crash\n");
    process.exit(3);
  }

  let reply = `echo: ${text}`;
  if (text === "ask") {
    const id = `ui-${++uiSeq}`;
    out({ type: "extension_ui_request", id, method: "confirm", title: "Proceed?", message: "Fake extension asks" });
    const answer = await new Promise((r) => uiWaiters.set(id, r));
    reply = `answer: ${JSON.stringify(answer)}`;
  }

  const toolResults = [];
  if (text === "tool") {
    const call = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
    const a = { role: "assistant", content: [call], provider: "fake", model: current.id, stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } } };
    out({ type: "message_start", message: { ...a, content: [] } });
    out({ type: "message_update", message: a, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call } });
    out({ type: "message_end", message: a });
    messages.push(a);
    out({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: call.arguments });
    out({ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: call.arguments, partialResult: { content: [{ type: "text", text: "hi" }] } });
    const tr = { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "hi\n" }], isError: false, timestamp: Date.now() };
    out({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: tr.content }, isError: false });
    out({ type: "message_start", message: tr });
    out({ type: "message_end", message: tr });
    messages.push(tr);
    toolResults.push(tr);
    out({ type: "turn_end", message: a, toolResults });
    out({ type: "turn_start" });
    reply = "ran the tool";
  }

  const base = { role: "assistant", provider: "fake", model: current.id, timestamp: Date.now() };
  out({ type: "message_start", message: { ...base, content: [] } });
  out({ type: "message_update", message: { ...base, content: [] }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  let acc = "";
  for (const w of reply.split(/(?<= )/)) {
    if (aborted) break;
    await sleep(delay);
    acc += w;
    out({ type: "message_update", message: { ...base, content: [{ type: "text", text: acc }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: w } });
  }
  const final = { ...base, content: [{ type: "text", text: acc }], stopReason: aborted ? "aborted" : "stop",
    usage: { input: 20, output: acc.length, cacheRead: 0, cacheWrite: 0, totalTokens: 20 + acc.length, cost: { total: 0 } } };
  out({ type: "message_end", message: final });
  messages.push(final);
  out({ type: "turn_end", message: final, toolResults: [] });
  out({ type: "agent_end", messages: [final] });
  streaming = false;
}

function handle(cmd) {
  switch (cmd.type) {
    case "get_state": return ok(cmd, state());
    case "get_messages": return ok(cmd, { messages });
    case "get_available_models": return ok(cmd, { models });
    case "set_model": {
      const m = models.find((x) => x.provider === cmd.provider && x.id === cmd.modelId);
      if (!m) return fail(cmd, `Model not found: ${cmd.provider}/${cmd.modelId}`);
      current = m;
      return ok(cmd, m);
    }
    case "set_thinking_level": thinking = cmd.level; return ok(cmd);
    case "set_session_name": name = cmd.name; return ok(cmd);
    case "get_session_stats":
      return ok(cmd, { sessionId: "fake-session", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0,
        contextUsage: { tokens: 1200, contextWindow: current.contextWindow, percent: 1.2 } });
    case "get_commands": return ok(cmd, { commands: [] });
    case "bash": {
      const { execSync } = require_("node:child_process");
      let output = "", exitCode = 0;
      try { output = execSync(cmd.command, { encoding: "utf8", shell: process.env.SHELL || "/bin/sh" }); } catch (e) { output = String(e.stdout ?? "") + String(e.stderr ?? ""); exitCode = e.status ?? 1; }
      messages.push({ role: "bashExecution", command: cmd.command, output, exitCode, cancelled: false, truncated: false, timestamp: Date.now() });
      return ok(cmd, { output, exitCode, cancelled: false, truncated: false });
    }
    case "abort": aborted = true; return ok(cmd);
    case "prompt":
      if (streaming && !cmd.streamingBehavior) return fail(cmd, "Agent is streaming; specify streamingBehavior");
      ok(cmd);
      if (!streaming) void run(cmd.message);
      else {
        // like real pi: queued; streamingBehavior is ignored when idle
        const steer = cmd.streamingBehavior === "steer";
        out({ type: "queue_update", steering: steer ? [cmd.message] : [], followUp: steer ? [] : [cmd.message] });
      }
      return;
    case "steer":
    case "follow_up":
      out({ type: "queue_update", steering: cmd.type === "steer" ? [cmd.message] : [], followUp: cmd.type === "follow_up" ? [cmd.message] : [] });
      return ok(cmd);
    case "extension_ui_response": {
      const w = uiWaiters.get(cmd.id);
      uiWaiters.delete(cmd.id);
      w?.(cmd.cancelled ? null : (cmd.confirmed ?? cmd.value));
      return;
    }
    default: return ok(cmd);
  }
}

const dec = new StringDecoder("utf8");
let buf = "";
process.stdin.on("data", (c) => {
  buf += dec.write(c);
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { out({ type: "response", command: "parse", success: false, error: String(e) }); }
  }
});
process.stdin.on("end", () => process.exit(0));
