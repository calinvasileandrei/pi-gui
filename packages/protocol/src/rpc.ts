// pi RPC wire types (pi 0.73.1, docs/rpc.md). Kept lenient: unknown fields pass through so
// pi upgrades that add fields don't break us. Only what the GUI reads is typed.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface TextContent { type: "text"; text: string }
export interface ThinkingContent { type: "thinking"; thinking: string }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: { total: number; [k: string]: number };
}

export interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}
export interface OtherMessage { role: "bashExecution" | "custom" | "branchSummary" | "compactionSummary"; timestamp: number; [k: string]: unknown }
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | OtherMessage;

export interface Model {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  [k: string]: unknown;
}

export interface SessionState {
  model: Model | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  [k: string]: unknown;
}

// ---- Commands (stdin) ----
type Img = { images?: ImageContent[] };
export type RpcCommand =
  | ({ type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" } & Img)
  | ({ type: "steer"; message: string } & Img)
  | ({ type: "follow_up"; message: string } & Img)
  | { type: "abort" }
  | { type: "new_session"; parentSession?: string }
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "cycle_model" }
  | { type: "get_available_models" }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "cycle_thinking_level" }
  | { type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  | { type: "compact"; customInstructions?: string }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "abort_retry" }
  | { type: "bash"; command: string }
  | { type: "abort_bash" }
  | { type: "get_session_stats" }
  | { type: "export_html"; outputPath?: string }
  | { type: "switch_session"; sessionPath: string }
  | { type: "fork"; entryId: string }
  | { type: "clone" }
  | { type: "get_fork_messages" }
  | { type: "get_last_assistant_text" }
  | { type: "set_session_name"; name: string }
  | { type: "get_commands" };

export type RpcCommandType = RpcCommand["type"];

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

// ---- Records (stdout) ----
export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type AssistantMessageEvent =
  | { type: "start" | "text_start" | "thinking_start" | "toolcall_start"; contentIndex?: number }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content?: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "done"; reason: string }
  | { type: "error"; reason: string };

export interface ToolResult { content: (TextContent | ImageContent)[]; details?: unknown }

export type ExtensionUiRequest = {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
};

export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export type RpcEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: ToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: string; result: unknown; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  | ExtensionUiRequest;

export type RpcRecord = RpcResponse | RpcEvent;
