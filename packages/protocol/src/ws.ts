// Browser <-> server WebSocket protocol. One socket per tab, multiplexed by channel.
// Channels: `session:<id>`, `terminal:<id>`, `run:<id>`, plus `app` for global state.

import type { RpcEvent, SessionState } from "./rpc.ts";

export type Channel = `session:${string}` | `terminal:${string}` | `run:${string}` | "app";

// ---- client -> server ----
export type ClientMessage =
  | { t: "sub"; ch: Channel; /** last seq the client has; server replays newer */ since?: number }
  | { t: "unsub"; ch: Channel }
  /** request/response RPC; `op` names a server operation, see ServerOps */
  | { t: "req"; id: string; op: string; args?: unknown }
  /** raw terminal input (hot path, no response) */
  | { t: "pty_in"; id: string; data: string }
  | { t: "pty_resize"; id: string; cols: number; rows: number };

// ---- server -> client ----
export type ServerMessage =
  | { t: "evt"; ch: Channel; seq: number; data: ChannelEvent }
  | { t: "res"; id: string; ok: true; data?: unknown }
  | { t: "res"; id: string; ok: false; error: string }
  /** server tells the client its buffer for a channel no longer covers `since`; client should reset that channel */
  | { t: "reset"; ch: Channel };

export type SessionStatus = "starting" | "idle" | "streaming" | "crashed" | "stopped";

export type Harness = "pi" | "claude";

export interface SessionInfo {
  id: string; // GUI-side session id (stable across pi restarts)
  cwd: string;
  status: SessionStatus;
  name?: string;
  sessionFile?: string;
  parentId?: string; // set for subagents
  agent?: string; // agent definition name, for subagents
  /** which agent runs it: pi (default) or the user's Claude Code */
  harness?: Harness;
  exitInfo?: { code: number | null; signal: string | null; stderrTail: string };
}

export type TerminalStatus = "stopped" | "running" | "exited" | "error";
export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  command: string;
  status: TerminalStatus;
  exitCode?: number | null;
  error?: string;
  profile: boolean; // saved profile vs run-once
  port?: number;
}

export type ChannelEvent =
  /** raw pi record, forwarded as-is */
  | { kind: "rpc"; record: RpcEvent }
  | { kind: "session_info"; info: SessionInfo }
  | { kind: "session_state"; state: SessionState }
  | { kind: "stderr"; text: string }
  | { kind: "pty_out"; data: string }
  | { kind: "terminal_info"; info: TerminalInfo }
  | { kind: "sessions"; sessions: SessionInfo[] }
  | { kind: "terminals"; terminals: TerminalInfo[] }
  | { kind: "config_errors"; errors: ConfigError[] }
  | { kind: "notes"; runId: string; notes: Note[] }
  | { kind: "toast"; level: "info" | "warning" | "error"; message: string }
  | { kind: "profiles"; project: string; profiles: TerminalProfileInfo[]; errors: ConfigError[] }
  | { kind: "changes_dirty"; sessionId: string; path?: string }
  | { kind: "runs"; parentSessionId: string; runs: SubagentRun[] }
  | { kind: "approval"; request: ApprovalRequest }
  | { kind: "approval_done"; id: string }
  | { kind: "agents_changed" }
  | { kind: "question"; question: ParentQuestion }
  | { kind: "question_done"; id: string }
  | { kind: "extensions_changed" }
  /** a watched folder of a project changed on disk (app channel) */
  | { kind: "fs_changed"; root: string; dir: string }
  | { kind: "mcp_changed"; root: string }
  /** the session history list changed (a new Claude Code session got its transcript) */
  | { kind: "stored_changed" }
  | { kind: "worktrees_changed"; repo: string };

// ---- file explorer ----
export interface FsEntry {
  name: string;
  /** relative to the project root, "/" separated */
  path: string;
  dir: boolean;
  link?: boolean;
  /** gitignored (shown dimmed) */
  ignored?: boolean;
}

export interface ConfigError { file: string; message: string }

export interface Note { id: string; ts: number; author: string; text: string }

// ---- M2 terminals ----
export interface TerminalProfileInfo {
  id: string;
  name: string;
  cwd: string;
  command: string;
  env: Record<string, string>;
  port?: number;
  autostart: boolean;
  restartOnExit: boolean;
  scope: "project" | "global";
  resolvedCwd: string;
  cwdError?: string;
}
export interface PortHolderInfo { pid: number; command: string }

// ---- M3 changes ----
export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
export interface ChangedFile {
  path: string; // relative to root
  oldPath?: string;
  status: ChangeStatus;
  additions?: number;
  deletions?: number;
  /** touched by the agent in this GUI session (pre-edit snapshot available) */
  agent: boolean;
  /** git index has changes for this path */
  staged?: boolean;
  /** working tree differs from the index */
  unstaged?: boolean;
}
export interface ChangesInfo { root: string; git: boolean; branch?: string; ahead?: number; behind?: number; upstream?: string; files: ChangedFile[] }
export interface FileDiff { path: string; original: string; modified: string; language: string; binary: boolean; tooLarge: boolean; base: "head" | "agent" }

// ---- M4 stored sessions (pi's session files) ----
export interface StoredSession {
  file: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
  created: string; // ISO
  modified: string; // ISO (mtime)
  messageCount: number;
  harness?: Harness;
  openId?: string; // GUI session id if currently open
}

// ---- M5 extensions ----
export interface ExtensionInfo {
  path: string; // absolute
  name: string;
  scope: "global" | "project";
  source: "auto" | "settings" | "package";
  enabled: boolean;
  builtin?: boolean; // gui-bridge
}

// ---- worktrees ----
export interface WorktreeInfo {
  path: string;
  head: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  locked?: string | boolean;
  prunable?: string | boolean;
  /** the repo's main checkout */
  main: boolean;
  /** folder is gone (deleted outside git) */
  missing?: boolean;
  dirty?: number;
  ahead?: number;
  behind?: number;
  upstream?: boolean;
  /** HEAD is already contained in the default branch */
  merged?: boolean;
  /** commits not on the default branch */
  unique?: number;
}
export interface WorktreeRepo {
  repo: string;
  name: string;
  /** the worktree the queried folder is in */
  current: string;
  defaultBranch?: string;
  worktrees: WorktreeInfo[];
}

// ---- MCP ----
/** one entry of `mcpServers` in ~/.pi/agent/mcp.json or <project>/.pi/mcp.json */
export interface McpServerConfig {
  type?: "stdio" | "http" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  disabledTools?: string[];
  timeout?: number;
}
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  enabled?: boolean;
}
export interface McpServerInfo {
  name: string;
  scope: "global" | "project";
  file: string;
  config: McpServerConfig;
  transport: "stdio" | "http" | "sse";
  status: "idle" | "connecting" | "connected" | "error" | "disabled";
  error?: string;
  stderr: string[];
  tools: McpToolInfo[];
  serverName?: string;
  serverVersion?: string;
  startedAt?: number;
}

// ---- M6 subagents ----
export type RunStatus = "queued" | "running" | "done" | "failed" | "aborted" | "timeout";
export interface SubagentRun {
  id: string;
  parentSessionId: string;
  toolCallId?: string;
  sessionId?: string; // child GUI session (for live view / steer / kill)
  agent: string;
  task: string;
  status: RunStatus;
  depth: number;
  startedAt?: number;
  endedAt?: number;
  report?: string;
  error?: string;
  turns: number;
}

// ---- M8 approvals ----
export interface ApprovalRequest {
  id: string;
  sessionId: string;
  tool: "edit" | "write";
  path: string; // absolute
  original: string;
  proposed: string;
  language: string;
}

/** ask_parent: a subagent's blocking question, routed to the human supervising the parent session */
export interface ParentQuestion { id: string; rootSessionId: string; runId?: string; from: string; text: string; ts: number }
