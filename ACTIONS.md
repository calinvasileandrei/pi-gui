# Pi GUI — Action List

Source: `pi-gui-harness-plan.md`. Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked / needs you

## M0 — Spike
- [x] 0.1 Pin pi version locally and read its RPC docs (`docs/rpc*.md`, `session-format.md`, extension docs)
- [x] 0.2 Spike script: spawn `pi --mode rpc`, send a prompt, print events
- [x] 0.3 Verify `node-pty` installs/builds on this machine
- [x] 0.4 Verify a real provider works through RPC — OpenRouter (`openrouter/anthropic/claude-haiku-4.5`) ✓. (Anthropic OAuth also wires up, but the account is out of extra usage.)
- [!] 0.5 Raise the security/policy question with the team (yours)

## M1 — Core chat
- [x] 1.1 Monorepo scaffold (pnpm workspaces, TS, `protocol`/`server`/`ui`/`pi-extension`)
- [x] 1.2 `protocol`: RPC record types, WS messages, config schemas (zod)
- [x] 1.3 JSONL framing (split on `\n` only, tolerate `\r`) + unit tests
- [x] 1.4 pi RPC adapter: spawn, id correlation, typed commands, normalized events
- [x] 1.5 Process supervisor: tracking, crash detection, restart, process-group kill
- [x] 1.6 Server: 127.0.0.1 bind, startup token, Origin check, WS channels, ring buffers
- [x] 1.7 UI shell: React + Vite + Zustand, WS client, layout
- [x] 1.8 Chat UI: streaming markdown, tool cards (bash/read/edit/generic), virtualized list
- [x] 1.9 Input: send / steer / follow-up / abort; model + thinking switcher; crash/restart state

**M1 exit check:** headless e2e vs fake pi passes (create, models, tool events, dialog, steer-while-streaming, abort, crash → restart, stats). Real-model run via server ✓: agent read → edit → bash-verified a bug fix in a scratch project (~$0.01); `kill -9` on pi → `crashed` (SIGKILL) → restart resumes the same session file with history. Visual check in browser ✓ (confirmed by you, 2026-11-03). **M1 done.**

## M1.5 — macOS app shell (Electron, like T3 Code)
- [x] 1.5.1 Refactor server into an embeddable `startApp()` (CLI + Electron share it; free-port support)
- [x] 1.5.2 Finder-launch robustness: resolve login-shell env (PATH/nvm), run pi via Electron's Node (`ELECTRON_RUN_AS_NODE`), scrub it from terminals
- [x] 1.5.3 `packages/desktop`: Electron main (window, token handoff, hardened webPreferences, external links, menus, window state, single instance, clean quit)
- [x] 1.5.4 Dev loop (`pnpm dev:desktop`) + self-screenshot check
- [x] 1.5.5 Package `.app` (arm64, ad-hoc signed) and verify it launches from Finder with no orphans on quit

**M1.5 done:** `pnpm --filter @pi-gui/desktop package` → `out/release/mac-arm64/pi.app` (arm64, ad-hoc signed, ~456 MB: Electron ~250 MB + pi's provider SDKs ~190 MB). Verified from a Finder-style `open`: login-shell PATH (node/pnpm/brew found), pi + all logins, node-pty, clean quit.

## M2 — Terminals
- [x] 2.1 PTY manager (login shell, process group, scrollback ring buffer)
- [x] 2.2 Terminal profiles config (`.pi/terminals.json` + global, path rules, validation, watch)
- [x] 2.3 Port check + kill holder
- [x] 2.4 xterm.js panel: tabs, start/stop/restart, Run once, resize, replay

## M3 — Diffs and changes
- [x] 3.1 Server: git status + file contents (HEAD vs working tree), per-file revert
- [x] 3.2 UI: changed-files panel + Monaco diff, open from edit tool cards

## M4 — Sessions
- [x] 4.1 Read pi session files; list per project
- [x] 4.2 Sidebar: new / resume / rename / delete, running/crashed state

## M5 — Extensions
- [x] 5.1 Extension UI record handler (dialogs/confirm/notify → modals/toasts)
- [x] 5.2 Extensions page: list, enable/disable, add from folder/git (show source), restart affected

## M6 — Subagents
- [x] 6.1 Agent definitions loader (`.pi/agents/*.md`, gray-matter, zod, watch)
- [x] 6.2 Run store / blackboard + HTTP API for the extension
- [x] 6.3 `gui-bridge` extension: `subagent`, `notes_read`, `notes_append`
- [x] 6.4 Server orchestration: spawn child, brief, report, limits (concurrency, depth, turns, time)
- [x] 6.5 UI: nested subagent panels, blackboard view
- [x] 6.6 Agents page (create/edit/validate)

## M7 — Agent ↔ terminal and polish
- [x] 7.1 `terminal_read` tool
- [x] 7.2 Command palette + keyboard shortcuts
- [x] 7.3 Token/context meter, rate-limit state

## M8 — Optional
- [x] Pre-apply approvals (shield toggle per session; Monaco diff of current vs proposed; approve/reject with a note to the agent)
- [x] `ask_parent` (blocking question → GUI dialog, 10-min timeout) + `message_parent` (progress shown live, appended to report)
- [x] Electron wrapper (M1.5)
- [ ] Git worktrees for parallel writing subagents — not done (writers are serialised per root session instead)

## UI restyle
- [x] Full redesign: dark-first + light theme (System/Light/Dark), violet accent, SF typography, Mac hidden-inset title bar; sidebar with projects → sessions (live + pi's stored sessions), search, rename/delete; tabs Chat / Changes / Subagents; floating composer; tool cards with per-tool icons; live subagent cards; blackboard; Monaco diffs; xterm panel; command palette (⌘K); toasts and custom dialogs


**All milestones done** except M8 worktrees and the terminal panel "pop-out" window. Verified 2026-11-04: 64 unit/contract tests; real-model runs inside the packaged app (OpenRouter Haiku): parallel scout subagents + blackboard + approval gate + edit tracking; screenshots of every screen in dark and light.

## Layout v2 — always-visible project panels
- [x] Four columns: sessions | file explorer | main | source control. Each can be hidden (top-bar toggles, ⌘\ sessions, ⌘B files, ⌘⌥B git), and the explorer and git panel can be resized (double-click resets); this is saved.
- [x] Everything follows the focused project: the explorer's project switcher, clicking a project in the sidebar, ⌘O and the palette all call `switchProject()`; that folder's newest open session becomes active.
- [x] Explorer: lazy tree, gitignored entries dimmed, git status colours (and a dot on folders containing changes), filter, keyboard navigation, context menu (new, rename, trash, reveal, copy path, add to chat). Only expanded folders are watched (chokidar, depth 0).
- [x] Drag & drop: move within the tree (⌥ copies), Finder → tree copies in (Electron `webUtils.getPathForFile`; base64 upload fallback in a browser), tree/Finder → composer inserts `@path`, → terminal pastes shell-quoted paths. Dropping onto a closed folder opens it after a short hover.
- [x] Source control panel: branch with ahead/behind, Staged and Changes sections, stage/unstage/discard per file or all at once, commit (or "commit all" when nothing is staged), ask the agent for a commit message, recent commits. Agent-edited files are marked even without git.
- [x] Editor tabs in the main area: files open in Monaco and can be edited (⌘S save with a stale-write guard, a "changed on disk" reload prompt) and diffs open alongside; ⌘W closes the tab (the menu's ⌘W is remapped; ⇧⌘W closes the window). The old Changes tab was removed.
- [x] Server: `files.ts` (confined to the root) + `ops/project.ts` (`fs.*`, `git.*`); 6 new tests (70 total).

## Notes
- pi pinned at `@mariozechner/pi-coding-agent@0.73.1` (bin `pi` → `dist/cli.js`). Agent dir override: `PI_CODING_AGENT_DIR`.
- Provider-agnostic: never hardcode Copilot; models come from `get_available_models`. Copilot = provider `github-copilot`.
- Extension loading: `-e <path>`; `--no-extensions` disables discovery. Tool allowlist: `--tools a,b`. Agent prompt: `--append-system-prompt`.
- Edit tool args: `{ path, edits: [{ oldText, newText }] }`.
- Spike (`spike/rpc-spike.mjs`): get_state OK, prompt without auth → `success:false` "No API key found" (handled).
- node-pty 1.1.0 ships prebuilds (darwin/win32), no compiler needed, but `spawn-helper` lacks +x after install → chmod at startup, else `posix_spawnp failed`.
- pnpm `allowBuilds` in `pnpm-workspace.yaml`: only esbuild may run install scripts; node-pty uses prebuilds.
- `packages/server/test/fake-pi.mjs`: protocol-speaking fake pi (prompts `crash`, `ask`, `tool`) for contract tests + UI dev without a provider. Use via `PI_GUI_PI_BIN="node packages/server/test/fake-pi.mjs"`.
- Server HTTP: plain `node:http` + `ws` (no Fastify) to keep the dependency footprint small for review.
- Security as built: loopback bind; random token (URL `#token=`); WS needs token + own Origin; HTTP `/api/*` needs Bearer + allow-listed op (extension only); Host header must be loopback (DNS-rebinding guard).
- Reconnect model: `session.snapshot` returns messages + bus `seq`; then `sub{since:seq}` → no gaps, no dupes. Bus returns `reset` if the ring no longer covers `since`.
- Abort: RPC `abort` with 5s timeout; if pi doesn't answer → kill + restart on same session file.
- `auto` prompt mode always sends `streamingBehavior:"steer"` (pi ignores it when idle) → no race with cached status.
- Model output is untrusted: markdown escapes raw HTML, only http(s)/mailto links, no remote images.
- Run: `pnpm dev` (real pi) or `pnpm dev:fake` (fake pi) → open the printed `http://127.0.0.1:5173/#token=…`. Prod: `pnpm build && pnpm start` → `http://127.0.0.1:4517/#token=…`.
- Anthropic Pro/Max via pi bills third-party harness use to *extra usage*; provider errors arrive as assistant `stopReason:"error"` + `errorMessage` (UI shows it inline). 400s are not auto-retried.
- pi sets its process title to `pi` (ps/pgrep show `pi`, not `cli.js`).
- Terminal kill on macOS: interactive shells (`-i`) use job control → each job gets its own pgid; macOS `pgrep` has no `-s`. We kill all processes on the pty's tty (`pgrep -t`) ∪ the ppid tree.
- Decision 2026-11-03: macOS app via **Electron** (T3 Code uses the same approach: local server + web UI + Electron shell). Browser mode kept for dev. node-pty is N-API → no Electron rebuild.
- Desktop verified: app window loads UI from embedded server (self-snapshot `PI_GUI_SNAPSHOT=…`); pi runs on Electron's Node (`ELECTRON_RUN_AS_NODE=1`) and sees all logins; node-pty loads in Electron; quit (SIGTERM / Cmd+Q path) stops pi + frees port.
- Ports: browser dev 4517/5173 · desktop dev 4518/5174 · packaged app picks a free port each launch.
- pi starts via `~/.pi-gui/pi-boot.mjs`: moves `PI_GUI_TOKEN` → `globalThis.__piGui` and deletes `ELECTRON_RUN_AS_NODE` before loading pi, so agent/bash-tool commands never see either.
- `!cmd` in the composer runs pi's `bash` RPC (output joins context on next prompt), like pi's TUI.
- Distribution: ad-hoc signature only. On another Mac: right-click → Open (or remove quarantine). Work machine likely needs Developer ID signing + notarization or IT approval.
- Server for M2–M7 + M8 approvals/ask_parent/message_parent implemented & unit-tested (64 tests). Real-model e2e (OpenRouter Haiku, $0.016 parent): terminal_read saw Metro error; 2 parallel `scout` subagents done with structured reports; blackboard 2 notes; agent edit tracked with exact pre-edit snapshot; children stopped after reporting.
- gui-bridge is loaded into every GUI pi via `-e`; its tool_call hook snapshots files *before* edit/write (blocking → exact) and is the approval gate. Loopback calls use node:http (not fetch) to dodge proxy dispatchers.
- Subagent rules: depth ≤ settings.subagentMaxDepth (default 1) unless parent agent has `canSpawn`; global concurrency semaphore (default 2); one writer per root session; turn/time limits; parent abort → child abort; crash → failed tool result.
- Shortcuts: ⌘K palette · ⌘N new session · ⌘O open folder · ⌘J terminal · ⌘1/2/3 Chat/Changes/Subagents · ⌘, settings · Enter send/steer · ⌥Enter queue · Esc stop · `!cmd` shell.
- Quit is bounded: graceful stop raced against 5s, then hard-kill of every child, then exit.
- Desktop automation hooks (env-gated, off by default): PI_GUI_SNAPSHOT_DIR (request.json → capture), PI_GUI_USER_DATA (isolated profile), PI_GUI_TOKEN_OVERRIDE/PI_GUI_PORT.

## MCP servers

pi has no MCP built in, by design. The GUI server is the MCP client, and the gui-bridge extension hands the tools to pi.

- [x] Config in `~/.pi/agent/mcp.json` (global) and `<project>/.pi/mcp.json`, using the `mcpServers` format from Claude Desktop and Cursor. A project entry overrides a global one with the same name. Files are written atomically with mode 0600.
- [x] `McpManager` (`packages/server/src/mcp.ts`) runs one connection per (project, server) over stdio, Streamable HTTP or SSE.
  - `${VAR}` values are filled in from the shell environment, and `PI_GUI_*` variables are removed from the server's environment.
  - It keeps the last lines of the server's stderr, picks up tool-list-changed notifications, and closes connections that have been idle for 10 minutes.
- [x] Bridge ops `bridge.mcpTools` and `bridge.mcpCall`. The extension re-syncs before every prompt, so adding, removing or toggling a server or tool applies to open sessions without a restart.
  - Tools are named `mcp__<server>__<tool>`.
  - Server instructions are added to the system prompt.
  - Input schemas are cleaned up so TypeBox can compile them.
- [x] MCP servers page:
  - Add or edit a server: local command or remote URL, env and headers, working directory, timeout, and "paste from a README".
  - Enable or disable a server, and each tool.
  - Connect, restart or stop a server; see its status, errors and server log.
  - Import from Claude Desktop, Cursor, Windsurf, VS Code, Claude Code, or the project's `.mcp.json`.
  - Edit the raw JSON in Monaco.
- [x] Sidebar badge (connected/total, or a failure count). Command palette entry. Subagents can be given `mcp__server__*` tool patterns (chips in the Agents editor).
- [x] Tests:
  - `mcp.test.ts`: 6 tests against a real stdio fixture server.
  - Real pi end to end: the model called `mcp__echo__echo`, and toggling a tool or server applied live.
- [ ] OAuth sign-in for remote servers. For now, use a token header.
- [ ] MCP resources and prompts. Only tools are supported.
