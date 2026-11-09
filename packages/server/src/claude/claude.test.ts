import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcEvent } from "@pi-gui/protocol";

// A stand-in for the `claude` CLI speaking its stream-json protocol: streams a reply with a Bash call,
// asks permission for it over stdio, then reports the tool result and the end of the turn.
const FAKE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sid = "11111111-2222-3333-4444-555555555555";
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    handle(m);
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(m) {
  if (m.type === "control_request" && m.request.subtype === "initialize")
    return out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [{ name: "review", description: "Review" }], models: [{ value: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "high"] }] } } });
  if (m.type === "control_request" && m.request.subtype === "set_model")
    return out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { model: "claude-x" } } });
  if (m.type === "control_response") {
    const allowed = m.response.response.behavior === "allow";
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: allowed ? "a.txt" : "denied", is_error: !allowed }] }, parent_tool_use_id: null });
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.25 }, seven_day: { utilization: 0.5 } } } });
    out({ type: "result", subtype: "success", is_error: false, modelUsage: { "claude-x": { contextWindow: 1000 } } });
    return;
  }
  if (m.type === "user") {
    out({ type: "system", subtype: "init", session_id: sid, model: "sonnet", permissionMode: "default" });
    const ev = (event) => out({ type: "stream_event", event, parent_tool_use_id: null });
    ev({ type: "message_start", message: { id: "m1", model: "claude-x", usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "look." } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "Bash", input: {} } });
    ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } });
    ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls"}' } });
    ev({ type: "content_block_stop", index: 1 });
    ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 20 } });
    ev({ type: "message_stop" });
    out({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } });
  }
}
`;

let dir: string;
let bin: string;
const realHome = process.env.HOME;
let mod: typeof import("./adapter.ts");
let tr: typeof import("./transcript.ts");

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-")));
  bin = join(dir, "claude");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  process.env.HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, ".claude");
  mod = await import("./adapter.ts");
  tr = await import("./transcript.ts");
});
afterAll(() => {
  process.env.HOME = realHome;
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe("Claude Code harness", () => {
  it("translates a turn into pi events, with the permission question as a dialog", async () => {
    const p = new mod.ClaudeProcess({ cwd: dir, bin });
    const events: RpcEvent[] = [];
    p.on("event", (e: RpcEvent) => {
      events.push(e);
      // answer the permission dialog like the GUI would
      if (e.type === "extension_ui_request" && e.method === "select") p.respondUi({ type: "extension_ui_response", id: e.id, value: "Allow" });
    });
    p.start();
    const models = await p.getModels();
    expect(models.models[0]).toMatchObject({ id: "sonnet", provider: "claude-code", thinkingLevels: ["low", "high"] });

    const ended = new Promise<void>((r) => p.on("event", (e: RpcEvent) => e.type === "agent_end" && r()));
    await p.prompt("list files");
    await ended;

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_start");
    expect(types.at(-1)).toBe("agent_end");
    const ask = events.find((e) => e.type === "extension_ui_request" && e.method === "select");
    expect(ask).toMatchObject({ title: "Allow Claude to use Bash?", message: "ls" });
    expect(events.find((e) => e.type === "tool_execution_start")).toMatchObject({ toolCallId: "tu1", toolName: "bash", args: { command: "ls" } });
    expect(events.find((e) => e.type === "tool_execution_end")).toMatchObject({ toolCallId: "tu1", isError: false });

    const { messages } = (await p.getMessages()) as { messages: any[] };
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(messages[1].content).toEqual([
      { type: "text", text: "Let me look." },
      { type: "toolCall", id: "tu1", name: "bash", arguments: { command: "ls" } },
    ]);
    const st = await p.getState();
    expect(st.planUsage).toEqual({ text: "5h 25% · week 50%", overage: false });
    expect(st).toMatchObject({ isStreaming: false, sessionId: "11111111-2222-3333-4444-555555555555", model: { id: "sonnet" } });
    expect(st.sessionFile).toBe(join(dir, ".claude/projects", dir.replace(/[^a-zA-Z0-9]/g, "-"), "11111111-2222-3333-4444-555555555555.jsonl"));
    const stats = await p.getStats();
    expect(stats.contextUsage).toMatchObject({ tokens: 120, contextWindow: 1000 });
    await p.stop();
  });

  it("reads a Claude Code transcript back as pi messages", async () => {
    const f = join(dir, ".claude/projects/-x/abc.jsonl");
    mkdirSync(join(dir, ".claude/projects/-x"), { recursive: true });
    const L = (o: object) => JSON.stringify(o);
    writeFileSync(
      f,
      [
        L({ type: "ai-title", aiTitle: "Fix bug" }),
        L({ type: "user", cwd: "/proj", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "fix it" }] } }),
        L({ type: "user", isMeta: true, cwd: "/proj", message: { role: "user", content: "<system-reminder>x</system-reminder>" } }),
        L({ type: "assistant", message: { id: "a", model: "m", content: [{ type: "thinking", thinking: "hmm" }] } }),
        L({ type: "assistant", message: { id: "a", model: "m", content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "/proj/x.ts", old_string: "a", new_string: "b" } }] } }),
        L({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "ok" }] }] } }),
        L({ type: "assistant", message: { id: "b", model: "m", content: [{ type: "text", text: "Done." }] } }),
        L({ type: "custom-title", customTitle: "My fix" }),
      ].join("\n") + "\n",
    );
    const msgs = await tr.readClaudeTranscript(f);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect((msgs[1] as any).content[1]).toEqual({ type: "toolCall", id: "t", name: "edit", arguments: { path: "/proj/x.ts", edits: [{ oldText: "a", newText: "b" }] } });
    expect(msgs[2]).toMatchObject({ toolName: "edit", content: [{ type: "text", text: "ok" }] });
    expect(await tr.readClaudeMeta(f)).toMatchObject({ cwd: "/proj", name: "My fix", firstMessage: "fix it", harness: "claude", messageCount: 4 });
  });
});
