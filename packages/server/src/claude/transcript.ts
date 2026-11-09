// Claude Code transcripts (~/.claude/projects/<cwd-slug>/<session>.jsonl) → pi-shaped messages,
// and Claude tool names/arguments → pi's, so tool cards and diffs render the same for both agents.
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentMessage, AssistantMessage, ImageContent, StoredSession, TextContent } from "@pi-gui/protocol";

export const CLAUDE_PROVIDER = "claude-code";

type Raw = Record<string, any>;

/** Claude Code tool call → the pi tool the GUI knows how to draw (unknown tools keep their name) */
export function toPiTool(name: string, input: Raw): { name: string; args: Record<string, unknown> } {
  const path = input.file_path ?? input.notebook_path ?? input.path;
  switch (name) {
    case "Bash":
      return { name: "bash", args: { command: input.command, ...(input.description ? { description: input.description } : {}) } };
    case "Read":
      return { name: "read", args: { path, ...(input.offset ? { offset: input.offset } : {}), ...(input.limit ? { limit: input.limit } : {}) } };
    case "Write":
      return { name: "write", args: { path, content: input.content } };
    case "Edit":
      return { name: "edit", args: { path, edits: [{ oldText: input.old_string ?? "", newText: input.new_string ?? "" }] } };
    case "MultiEdit":
      return { name: "edit", args: { path, edits: ((input.edits ?? []) as Raw[]).map((e) => ({ oldText: e.old_string ?? "", newText: e.new_string ?? "" })) } };
    case "NotebookEdit":
      return { name: "edit", args: { path, edits: [{ oldText: "", newText: input.new_source ?? "" }] } };
    case "Grep":
      return { name: "grep", args: { pattern: input.pattern, ...(input.path ? { path: input.path } : {}) } };
    case "Glob":
      return { name: "find", args: { pattern: input.pattern, ...(input.path ? { path: input.path } : {}) } };
    case "LS":
      return { name: "ls", args: { path } };
    default:
      return { name, args: input };
  }
}

export function toolResultContent(c: unknown): (TextContent | ImageContent)[] {
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (!Array.isArray(c)) return [];
  const out: (TextContent | ImageContent)[] = [];
  for (const b of c as Raw[]) {
    if (b?.type === "text") out.push({ type: "text", text: String(b.text ?? "") });
    else if (b?.type === "image" && b.source?.data) out.push({ type: "image", data: b.source.data, mimeType: b.source.media_type ?? "image/png" });
  }
  return out;
}

const ts = (r: Raw) => (r.timestamp ? Date.parse(r.timestamp) || Date.now() : Date.now());

/** text the user typed (not reminders, command wrappers or tool results) */
function userText(content: unknown): string | undefined {
  const parts = typeof content === "string" ? [content] : Array.isArray(content) ? (content as Raw[]).filter((b) => b?.type === "text").map((b) => String(b.text)) : [];
  const text = parts.filter((t) => !/^\s*<(system-reminder|local-command|command-name|command-message|command-args)/.test(t)).join("\n").trim();
  return text || undefined;
}

function lines(raw: string): Raw[] {
  const out: Raw[] = [];
  for (const l of raw.split("\n")) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* partial last line */
    }
  }
  return out;
}

/** The conversation of a Claude Code session, as pi messages. */
export async function readClaudeTranscript(file: string): Promise<AgentMessage[]> {
  const recs = lines(await readFile(file, "utf8").catch(() => ""));
  const out: AgentMessage[] = [];
  const names = new Map<string, string>();
  let last: { id: string; msg: AssistantMessage } | undefined;
  for (const r of recs) {
    if (r.isSidechain || r.isMeta) continue;
    if (r.type === "assistant" && r.message) {
      const m = r.message as Raw;
      // a streamed reply is stored one content block per line, sharing message.id
      let msg = last && last.id === m.id ? last.msg : undefined;
      if (!msg) {
        msg = { role: "assistant", content: [], provider: CLAUDE_PROVIDER, model: m.model, timestamp: ts(r), stopReason: "stop" };
        out.push(msg);
        last = { id: m.id, msg };
      }
      for (const b of (m.content ?? []) as Raw[]) {
        if (b.type === "text" && b.text) msg.content.push({ type: "text", text: b.text });
        else if (b.type === "thinking" && b.thinking) msg.content.push({ type: "thinking", thinking: b.thinking });
        else if (b.type === "tool_use") {
          const t = toPiTool(b.name, b.input ?? {});
          names.set(b.id, t.name);
          msg.content.push({ type: "toolCall", id: b.id, name: t.name, arguments: t.args });
          msg.stopReason = "toolUse";
        }
      }
      if (r.error || r.isApiErrorMessage) msg.stopReason = "error";
      continue;
    }
    if (r.type === "user" && r.message) {
      const c = r.message.content;
      if (Array.isArray(c))
        for (const b of c as Raw[])
          if (b?.type === "tool_result")
            out.push({ role: "toolResult", toolCallId: b.tool_use_id, toolName: names.get(b.tool_use_id) ?? "tool", content: toolResultContent(b.content), isError: !!b.is_error, timestamp: ts(r) });
      const text = r.isCompactSummary ? undefined : userText(c);
      if (text) {
        out.push({ role: "user", content: text, timestamp: ts(r) });
        last = undefined;
      }
      if (r.isCompactSummary) out.push({ role: "compactionSummary", timestamp: ts(r) });
    }
  }
  return out;
}

/** List metadata for the session history. */
export async function readClaudeMeta(file: string): Promise<Omit<StoredSession, "openId"> | null> {
  const st = await stat(file).catch(() => null);
  if (!st) return null;
  const recs = lines(await readFile(file, "utf8").catch(() => ""));
  let cwd: string | undefined;
  let created: string | undefined;
  let custom: string | undefined;
  let ai: string | undefined;
  let firstMessage: string | undefined;
  let messageCount = 0;
  for (const r of recs) {
    if (r.type === "custom-title" && r.customTitle) custom = r.customTitle;
    else if (r.type === "ai-title" && r.aiTitle) ai = r.aiTitle;
    if (r.type !== "user" && r.type !== "assistant") continue;
    cwd ??= r.cwd;
    created ??= r.timestamp;
    if (r.isSidechain || r.isMeta) continue;
    if (r.type === "user") {
      const t = userText(r.message?.content);
      if (t) {
        messageCount++;
        firstMessage ??= t.slice(0, 200);
      }
    } else messageCount++;
  }
  if (!cwd) return null;
  return {
    file,
    id: basename(file, ".jsonl"),
    cwd,
    name: custom ?? ai,
    firstMessage,
    created: created ?? st.birthtime.toISOString(),
    modified: st.mtime.toISOString(),
    messageCount,
    harness: "claude",
  };
}
