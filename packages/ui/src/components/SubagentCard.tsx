import { useEffect, useState } from "react";
import { ChevronRight, MessageSquareShare, ScrollText, Square } from "lucide-react";
import type { AgentMessage, SubagentRun } from "@pi-gui/protocol";
import { act, promptDialog, req } from "../store.ts";
import { renderMarkdown } from "../markdown.ts";
import { Modal } from "./ui.tsx";
import { MessageList } from "./ChatView.tsx";
import { emptyChat } from "../chat-state.ts";

export function elapsed(r: SubagentRun, now = Date.now()) {
  if (!r.startedAt) return "";
  const s = Math.round(((r.endedAt ?? now) - r.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATUS_LABEL: Record<SubagentRun["status"], string> = { queued: "queued", running: "running", done: "done", failed: "failed", aborted: "stopped", timeout: "timed out" };

export function SubagentCard({ run, sessionId: _sid, defaultOpen }: { run: SubagentRun; sessionId: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [transcript, setTranscript] = useState(false);
  const [, tick] = useState(0);
  const live = run.status === "running" || run.status === "queued";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  const badge = run.status === "done" ? "ok" : run.status === "running" ? "accent" : run.status === "queued" ? "warn" : "err";
  return (
    <div className="subagent">
      <div className="subagent-head">
        <span className="avatar agent" style={{ width: 24, height: 24, fontSize: 11 }}>
          {run.agent.slice(0, 1).toUpperCase()}
        </span>
        <div className="grow">
          <div className="title row" style={{ gap: 6 }}>
            {run.agent}
            <span className={`badge ${badge}`}>
              {run.status === "running" && <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} />}
              {STATUS_LABEL[run.status]}
            </span>
            <span className="faint tiny">
              {run.turns} turn{run.turns === 1 ? "" : "s"} · {elapsed(run)}
            </span>
          </div>
          <div className="task" title={run.task}>
            {run.task}
          </div>
        </div>
        {live && run.sessionId && (
          <button
            className="btn sm ghost"
            title="Send a steering message to this subagent"
            onClick={async () => {
              const m = await promptDialog({ title: `Steer ${run.agent}`, placeholder: "e.g. focus on the iOS folder only", confirm: "Send" });
              if (m) await act(req("session.prompt", { id: run.sessionId, message: m, mode: "steer" }), "Sent");
            }}
          >
            <MessageSquareShare size={13} /> Steer
          </button>
        )}
        {run.sessionId && (
          <button className="btn sm ghost" onClick={() => setTranscript(true)}>
            <ScrollText size={13} /> Transcript
          </button>
        )}
        {live && (
          <button className="btn sm ghost danger" onClick={() => void act(req("runs.kill", { runId: run.id }))}>
            <Square size={11} /> Stop
          </button>
        )}
        {(run.report || run.error) && (
          <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="Toggle report">
            <ChevronRight size={14} className={`tool-chev ${open ? "open" : ""}`} />
          </button>
        )}
      </div>
      {run.error && run.status !== "done" && <div className="subagent-progress err-text">{run.error}</div>}
      {open && (run.report || run.error) && (
        <div className="subagent-report">{run.report ? <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(run.report) }} /> : <span className="err-text">{run.error}</span>}</div>
      )}
      {transcript && run.sessionId && <TranscriptModal run={run} onClose={() => setTranscript(false)} />}
    </div>
  );
}

function TranscriptModal({ run, onClose }: { run: SubagentRun; onClose: () => void }) {
  const [messages, setMessages] = useState<AgentMessage[]>();
  useEffect(() => {
    let alive = true;
    const load = () =>
      req<{ messages: AgentMessage[] }>("session.snapshot", { id: run.sessionId })
        .then((s) => alive && setMessages(s.messages))
        .catch(() => req<AgentMessage[]>("runs.transcript", { runId: run.id }).then((m) => alive && setMessages(m), () => alive && setMessages([])));
    void load();
    const t = run.status === "running" ? setInterval(load, 2000) : undefined;
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [run.sessionId, run.status, run.id]);
  return (
    <Modal wide onClose={onClose}>
      <div className="modal-head">
        <div className="grow">
          <h3>
            {run.agent} — transcript
          </h3>
          <p className="ellipsis">{run.task}</p>
        </div>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{messages ? <MessageList chat={{ ...emptyChat(), messages, loaded: true }} sessionId={run.sessionId!} /> : <div className="empty-state"><span className="spinner" /></div>}</div>
    </Modal>
  );
}
