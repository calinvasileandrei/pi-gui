import { useEffect, useRef, useState } from "react";
import { ArrowUp, CornerDownLeft, ListPlus, Square, TerminalSquare } from "lucide-react";
import type { ChatState } from "../chat-state.ts";
import { composerState, drafts, req, useApp } from "../store.ts";
import { droppedFiles, hasFiles, hasInternal, readInternal } from "../dnd.ts";
import { Kbd } from "./ui.tsx";

/**
 * Enter: send (idle) / steer (while working)   ⌥Enter: queue follow-up
 * ⇧Enter: newline   Esc: abort   !cmd: run a shell command (output joins context)
 */
export function Composer({ id, chat }: { id: string; chat: ChatState }) {
  const [text, setText] = useState(() => drafts.get(id) ?? "");
  const [err, setErr] = useState<string>();
  const [dropping, setDropping] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const cwd = chat.info?.cwd;
  const updateChat = useApp((s) => s.updateChat);
  const status = chat.info?.status;
  const busy = status === "streaming";
  const usable = status === "idle" || status === "streaming";
  const agent = chat.info?.harness === "claude" ? "Claude" : "pi";
  const isBash = text.trimStart().startsWith("!");

  useEffect(() => {
    setText(drafts.get(id) ?? "");
    composerState.mounted = id;
    const el = ta.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return () => {
      if (composerState.mounted === id) composerState.mounted = undefined;
    };
  }, [id]);
  useEffect(() => {
    drafts.set(id, text);
  }, [id, text]);

  /** insert at the cursor, padding with spaces so mentions don't glue to words */
  function insertAtCursor(t: string) {
    const el = ta.current;
    const cur = el?.value ?? text;
    const a = el?.selectionStart ?? cur.length;
    const b = el?.selectionEnd ?? cur.length;
    const before = cur.slice(0, a);
    const pre = before && !/\s$/.test(before) ? " " : "";
    const next = before + pre + t + cur.slice(b);
    setText(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = (before + pre + t).length;
      el.setSelectionRange(pos, pos);
    });
  }
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; text: string }>).detail;
      if (d.id === id) insertAtCursor(d.text);
    };
    window.addEventListener("pi-gui:insert", h);
    return () => window.removeEventListener("pi-gui:insert", h);
  });

  const mention = (abs: string) => {
    const rel = cwd && abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;
    return `@${/\s/.test(rel) ? `"${rel}"` : rel}`;
  };
  function onDrop(e: React.DragEvent) {
    setDropping(false);
    const dt = e.dataTransfer;
    if (!hasInternal(dt) && !hasFiles(dt)) return;
    e.preventDefault();
    const internal = hasInternal(dt) ? readInternal(dt) : undefined;
    const paths = internal ? internal.paths.map((p) => `${internal.root}/${p}`) : droppedFiles(dt).paths;
    if (!paths.length) {
      setErr("Dropped files have no path in the browser — use the Mac app, or drop them into the file tree first.");
      return;
    }
    insertAtCursor(paths.map(mention).join(" ") + " ");
  }
  // extension asked to prefill the editor (set_editor_text)
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; text: string }>).detail;
      if (d.id === id) {
        setText(d.text);
        ta.current?.focus();
      }
    };
    window.addEventListener("pi-gui:editor-text", h);
    return () => window.removeEventListener("pi-gui:editor-text", h);
  }, [id]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(260, el.scrollHeight) + "px";
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && busy && !document.querySelector(".overlay")) void abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function send(mode: "auto" | "steer" | "followUp") {
    const message = text.trim();
    if (!message || !usable) return;
    setErr(undefined);
    setText("");
    if (message.startsWith("!") && message.length > 1) return runBash(message.slice(1).trim());
    try {
      await req("session.prompt", { id, message, mode });
    } catch (e) {
      setText(message);
      setErr((e as Error).message);
    }
  }

  async function runBash(command: string) {
    const ts = Date.now();
    const show = (output: string, exitCode?: number) =>
      updateChat(id, (c) => ({
        ...c,
        messages: [...c.messages.filter((m) => !(m.role === "bashExecution" && m.timestamp === ts)), { role: "bashExecution", command, output, exitCode, timestamp: ts }],
        changesVersion: c.changesVersion + 1,
      }));
    show("running…");
    try {
      const r = await req<{ output: string; exitCode?: number; truncated?: boolean; fullOutputPath?: string }>("session.bash", { id, command });
      show(r.output + (r.truncated ? `\n… truncated (full output: ${r.fullOutputPath})` : ""), r.exitCode);
    } catch (e) {
      show(`error: ${(e as Error).message}`);
    }
  }

  async function abort() {
    try {
      const r = await req("session.abort", { id });
      if (r?.hard) setErr("pi didn't respond to abort — restarted it on the same session.");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const queued = [...chat.queue.steering.map((q) => ["Steer", q] as const), ...chat.queue.followUp.map((q) => ["Follow-up", q] as const)];

  return (
    <div className="composer-wrap">
      {Object.keys(chat.status).length > 0 && (
        <div className="ext-status">
          {Object.entries(chat.status).map(([k, v]) => (
            <span key={k} className="badge">
              {v}
            </span>
          ))}
        </div>
      )}
      {Object.keys(chat.widgets).length > 0 && (
        <div className="ext-widgets">
          {Object.entries(chat.widgets).map(([k, lines]) => (
            <pre key={k} className="ext-widget">
              {lines.join("\n")}
            </pre>
          ))}
        </div>
      )}
      {queued.length > 0 && (
        <div className="queue-chips">
          {queued.map(([k, q], i) => (
            <div key={i} className="queue-chip">
              <span className="badge accent">{k}</span>
              <span className="ellipsis">{q}</span>
            </div>
          ))}
        </div>
      )}
      {err && <div className="composer-error">{err}</div>}
      <div
        className={`composer ${dropping ? "dropping" : ""}`}
        onDragOver={(e) => {
          if (!hasInternal(e.dataTransfer) && !hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
        onDrop={onDrop}
      >
        <textarea
          ref={ta}
          value={text}
          rows={1}
          placeholder={!usable ? `Session is ${status ?? "loading"}…` : busy ? `Steer ${agent} while it works… (⌥⏎ to queue a follow-up)` : `Ask ${agent} to build, fix or explain something…`}
          disabled={!usable}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(e.altKey ? "followUp" : "auto");
            }
          }}
        />
        <div className="composer-bar">
          <span className="composer-hint">
            {isBash ? (
              <>
                <TerminalSquare size={13} /> Shell command — runs in the session folder
              </>
            ) : busy ? (
              <>
                <Kbd>⏎</Kbd> steer · <Kbd>⌥⏎</Kbd> queue · <Kbd>esc</Kbd> stop
              </>
            ) : (
              <>
                <Kbd>⏎</Kbd> send · <Kbd>⇧⏎</Kbd> newline · <Kbd>!</Kbd> shell
              </>
            )}
          </span>
          <span className="grow" />
          {busy && (
            <>
              <button className="btn sm ghost" disabled={!text.trim()} onClick={() => void send("followUp")} title="Queue as follow-up (⌥⏎)">
                <ListPlus size={13} /> Queue
              </button>
              <button className="btn sm ghost" disabled={!text.trim()} onClick={() => void send("steer")} title="Steer now (⏎)">
                <CornerDownLeft size={13} /> Steer
              </button>
              <button className="stop-btn" onClick={() => void abort()} title="Stop (esc)">
                <Square size={12} fill="currentColor" />
              </button>
            </>
          )}
          {!busy && (
            <button className="send-btn" onClick={() => void send("auto")} disabled={!text.trim() || !usable} title="Send (⏎)">
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
