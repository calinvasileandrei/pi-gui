import type {
  ApprovalRequest,
  Note,
  ParentQuestion,
  SubagentRun,
  AgentMessage,
  AssistantMessage,
  ChannelEvent,
  ExtensionUiRequest,
  RpcEvent,
  SessionInfo,
  SessionState,
  ToolResult,
  ToolResultMessage,
} from "@pi-gui/protocol";

export interface ToolRun {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  partial?: ToolResult;
  result?: ToolResult;
}

export interface Notice {
  id: number;
  level: "info" | "warning" | "error";
  text: string;
}

export interface ChatState {
  info?: SessionInfo;
  state?: SessionState;
  messages: AgentMessage[];
  /** in-flight assistant message (latest partial) */
  streaming: AssistantMessage | null;
  tools: Record<string, ToolRun>;
  queue: { steering: string[]; followUp: string[] };
  notices: Notice[];
  uiRequests: ExtensionUiRequest[];
  status: Record<string, string>; // extension setStatus
  widgets: Record<string, string[]>;
  stderr: string;
  retry?: { attempt: number; maxAttempts: number; errorMessage: string };
  compacting: boolean;
  loaded: boolean;
  runs: SubagentRun[];
  notes: Note[];
  approvals: ApprovalRequest[];
  questions: ParentQuestion[];
  /** bumps whenever files may have changed (agent edit/write/bash, revert) */
  changesVersion: number;
}

export const emptyChat = (): ChatState => ({
  messages: [],
  streaming: null,
  tools: {},
  queue: { steering: [], followUp: [] },
  notices: [],
  uiRequests: [],
  status: {},
  widgets: {},
  stderr: "",
  compacting: false,
  loaded: false,
  runs: [],
  notes: [],
  approvals: [],
  questions: [],
  changesVersion: 0,
});

let noticeId = 0;
const notice = (s: ChatState, level: Notice["level"], text: string): Notice[] =>
  [...s.notices, { id: ++noticeId, level, text }].slice(-20);

export function applySnapshot(s: ChatState, snap: { info: SessionInfo; state?: SessionState; messages: AgentMessage[] }): ChatState {
  return { ...s, info: snap.info, state: snap.state, messages: snap.messages, streaming: null, loaded: true };
}

/** Pure reducer: channel event -> new chat state. */
export function reduceChat(s: ChatState, e: ChannelEvent): ChatState {
  switch (e.kind) {
    case "session_info":
      return { ...s, info: e.info };
    case "session_state":
      return { ...s, state: e.state };
    case "stderr":
      return { ...s, stderr: (s.stderr + e.text).slice(-8000) };
    case "rpc":
      return reduceRpc(s, e.record);
    case "runs":
      return { ...s, runs: e.runs };
    case "notes":
      return { ...s, notes: e.notes };
    case "approval":
      return { ...s, approvals: [...s.approvals.filter((a) => a.id !== e.request.id), e.request] };
    case "approval_done":
      return { ...s, approvals: s.approvals.filter((a) => a.id !== e.id) };
    case "question":
      return { ...s, questions: [...s.questions.filter((q) => q.id !== e.question.id), e.question] };
    case "question_done":
      return { ...s, questions: s.questions.filter((q) => q.id !== e.id) };
    case "changes_dirty":
      return { ...s, changesVersion: s.changesVersion + 1 };
    default:
      return s;
  }
}

function reduceRpc(s: ChatState, r: RpcEvent): ChatState {
  switch (r.type) {
    case "message_start":
      if (r.message.role === "assistant") return { ...s, streaming: r.message as AssistantMessage };
      return s;
    case "message_update":
      return { ...s, streaming: r.message as AssistantMessage };
    case "message_end": {
      const m = r.message;
      // dedupe: after a snapshot the same message may also arrive live
      const last = s.messages.at(-1);
      const dup = last && last.role === m.role && last.timestamp === m.timestamp;
      const messages = dup ? [...s.messages.slice(0, -1), m] : [...s.messages, m];
      return { ...s, messages, streaming: m.role === "assistant" ? null : s.streaming };
    }
    case "tool_execution_start":
      return { ...s, tools: { ...s.tools, [r.toolCallId]: { id: r.toolCallId, name: r.toolName, args: r.args, status: "running" } } };
    case "tool_execution_update": {
      const t = s.tools[r.toolCallId] ?? { id: r.toolCallId, name: r.toolName, args: r.args, status: "running" as const };
      return { ...s, tools: { ...s.tools, [r.toolCallId]: { ...t, partial: r.partialResult } } };
    }
    case "tool_execution_end": {
      const t = s.tools[r.toolCallId] ?? { id: r.toolCallId, name: r.toolName, args: {}, status: "running" as const };
      const touchesFiles = r.toolName === "edit" || r.toolName === "write" || r.toolName === "bash";
      return {
        ...s,
        tools: { ...s.tools, [r.toolCallId]: { ...t, status: r.isError ? "error" : "done", result: r.result } },
        changesVersion: touchesFiles ? s.changesVersion + 1 : s.changesVersion,
      };
    }
    case "queue_update":
      return { ...s, queue: { steering: r.steering, followUp: r.followUp } };
    case "agent_end":
      return { ...s, streaming: null, retry: undefined };
    case "compaction_start":
      return { ...s, compacting: true, notices: notice(s, "info", `Compacting context (${r.reason})…`) };
    case "compaction_end":
      return {
        ...s,
        compacting: false,
        notices: r.errorMessage
          ? notice(s, "error", `Compaction failed: ${r.errorMessage}`)
          : r.aborted
            ? notice(s, "warning", "Compaction aborted")
            : notice(s, "info", "Context compacted"),
      };
    case "auto_retry_start":
      return { ...s, retry: { attempt: r.attempt, maxAttempts: r.maxAttempts, errorMessage: r.errorMessage } };
    case "auto_retry_end":
      return {
        ...s,
        retry: undefined,
        notices: r.success ? s.notices : notice(s, "error", `Retries exhausted: ${r.finalError ?? "unknown error"}`),
      };
    case "extension_error":
      return { ...s, notices: notice(s, "error", `Extension error (${r.event}): ${r.error}`) };
    case "extension_ui_request":
      switch (r.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor":
          return { ...s, uiRequests: [...s.uiRequests, r] };
        case "notify":
          return { ...s, notices: notice(s, r.notifyType ?? "info", r.message ?? "") };
        case "setStatus": {
          const status = { ...s.status };
          if (r.statusText) status[r.statusKey!] = r.statusText;
          else delete status[r.statusKey!];
          return { ...s, status };
        }
        case "setWidget": {
          const widgets = { ...s.widgets };
          if (r.widgetLines) widgets[r.widgetKey!] = r.widgetLines;
          else delete widgets[r.widgetKey!];
          return { ...s, widgets };
        }
        default:
          return s;
      }
    default:
      return s;
  }
}

export function resolveUiRequest(s: ChatState, id: string): ChatState {
  return { ...s, uiRequests: s.uiRequests.filter((r) => r.id !== id) };
}

export function dismissNotice(s: ChatState, id: number): ChatState {
  return { ...s, notices: s.notices.filter((n) => n.id !== id) };
}

/** toolCallId -> toolResult message, for rendering completed tool cards from history */
export function resultsById(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const m = new Map<string, ToolResultMessage>();
  for (const x of messages) if (x.role === "toolResult") m.set(x.toolCallId, x);
  return m;
}
