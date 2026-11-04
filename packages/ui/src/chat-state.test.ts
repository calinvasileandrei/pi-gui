import { describe, expect, it } from "vitest";
import type { ChannelEvent, RpcEvent } from "@pi-gui/protocol";
import { applySnapshot, emptyChat, reduceChat } from "./chat-state.ts";
import { renderMarkdown } from "./markdown.ts";

const rpc = (record: RpcEvent): ChannelEvent => ({ kind: "rpc", record });
const asst = (text: string, ts = 1) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: ts });

describe("reduceChat", () => {
  it("tracks the streaming partial and commits on message_end", () => {
    let s = emptyChat();
    s = reduceChat(s, rpc({ type: "message_start", message: asst("") }));
    s = reduceChat(s, rpc({ type: "message_update", message: asst("Hel"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } }));
    expect(s.streaming?.content[0]).toEqual({ type: "text", text: "Hel" });
    s = reduceChat(s, rpc({ type: "message_end", message: asst("Hello") }));
    expect(s.streaming).toBeNull();
    expect(s.messages).toHaveLength(1);
  });

  it("does not duplicate a message present in the snapshot", () => {
    let s = applySnapshot(emptyChat(), { info: { id: "x", cwd: "/", status: "idle" }, messages: [asst("Hi", 5)] });
    s = reduceChat(s, rpc({ type: "message_end", message: asst("Hi", 5) }));
    expect(s.messages).toHaveLength(1);
  });

  it("follows a tool through start/update/end", () => {
    let s = emptyChat();
    s = reduceChat(s, rpc({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "ls" } }));
    s = reduceChat(s, rpc({ type: "tool_execution_update", toolCallId: "t", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "a" }] } }));
    expect(s.tools.t!.status).toBe("running");
    s = reduceChat(s, rpc({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: { content: [{ type: "text", text: "ab" }] }, isError: true }));
    expect(s.tools.t!.status).toBe("error");
    expect(s.tools.t!.args).toEqual({ command: "ls" });
  });

  it("queues dialogs, shows notifies as notices, tracks status keys", () => {
    let s = emptyChat();
    s = reduceChat(s, rpc({ type: "extension_ui_request", id: "1", method: "confirm", title: "ok?" }));
    s = reduceChat(s, rpc({ type: "extension_ui_request", id: "2", method: "notify", message: "hey", notifyType: "warning" }));
    s = reduceChat(s, rpc({ type: "extension_ui_request", id: "3", method: "setStatus", statusKey: "k", statusText: "busy" }));
    expect(s.uiRequests.map((r) => r.id)).toEqual(["1"]);
    expect(s.notices.at(-1)).toMatchObject({ level: "warning", text: "hey" });
    expect(s.status).toEqual({ k: "busy" });
    s = reduceChat(s, rpc({ type: "extension_ui_request", id: "4", method: "setStatus", statusKey: "k" }));
    expect(s.status).toEqual({});
  });
});

describe("renderMarkdown (untrusted model output)", () => {
  it("escapes raw HTML", () => {
    const h = renderMarkdown('hi <img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(h).not.toMatch(/<img|<script/i);
  });
  it("drops javascript: links and remote images", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href");
    expect(renderMarkdown("![t](https://evil.example/p.png)")).not.toContain("<img");
  });
  it("keeps https links and code", () => {
    const h = renderMarkdown("[a](https://example.com)\n\n```ts\nconst a = '<b>';\n```");
    expect(h).toContain('href="https://example.com"');
    expect(h).toContain("&lt;b&gt;");
  });
});
