import { useEffect, useMemo, useState } from "react";
import { MessageCircleQuestion, Puzzle, ShieldCheck } from "lucide-react";
import type { ApprovalRequest, ExtensionUiRequest, ParentQuestion } from "@pi-gui/protocol";
import { resolveUiRequest } from "../chat-state.ts";
import { act, req, useApp } from "../store.ts";
import { DiffEditor } from "./DiffEditor.tsx";
import { Modal, shortPath } from "./ui.tsx";

/** Pick the first pending item across sessions, preferring the active one. */
function usePending<T>(pick: (c: ReturnType<typeof useApp.getState>["chats"][string]) => T[]): { sessionId: string; item: T } | undefined {
  const { chats, activeId } = useApp();
  return useMemo(() => {
    const ids = [activeId, ...Object.keys(chats)].filter(Boolean) as string[];
    for (const id of ids) {
      const xs = chats[id] ? pick(chats[id]!) : [];
      if (xs.length) return { sessionId: id, item: xs[0]! };
    }
    return undefined;
  }, [chats, activeId]);
}

export function Dialogs() {
  const ui = usePending((c) => c.uiRequests);
  const approval = usePending((c) => c.approvals);
  const question = usePending((c) => c.questions);
  if (approval) return <ApprovalDialog key={approval.item.id} sessionId={approval.sessionId} r={approval.item} />;
  if (question) return <QuestionDialog key={question.item.id} sessionId={question.sessionId} q={question.item} />;
  if (ui) return <ExtensionUiDialog key={ui.item.id} sessionId={ui.sessionId} r={ui.item} />;
  return null;
}

// ---------- extension UI (pi RPC extension_ui_request) ----------
function ExtensionUiDialog({ sessionId, r }: { sessionId: string; r: ExtensionUiRequest }) {
  const [value, setValue] = useState(r.method === "editor" ? (r.prefill ?? "") : "");
  const [hl, setHl] = useState(0);
  const [left, setLeft] = useState(r.timeout ? Math.ceil(r.timeout / 1000) : undefined);
  const name = useApp((s) => s.sessions.find((x) => x.id === sessionId)?.name);

  const respond = (response: Record<string, unknown>) => {
    useApp.getState().updateChat(sessionId, (c) => resolveUiRequest(c, r.id));
    void act(req("session.uiRespond", { id: sessionId, response: { id: r.id, ...response } }));
  };
  const cancel = () => respond({ cancelled: true });

  useEffect(() => {
    if (left === undefined) return;
    if (left <= 0) {
      // pi auto-resolves on its side; just drop the dialog
      useApp.getState().updateChat(sessionId, (c) => resolveUiRequest(c, r.id));
      return;
    }
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  useEffect(() => {
    if (r.method !== "select") return;
    const k = (e: KeyboardEvent) => {
      const n = r.options?.length ?? 0;
      if (e.key === "ArrowDown") setHl((h) => (h + 1) % n);
      else if (e.key === "ArrowUp") setHl((h) => (h - 1 + n) % n);
      else if (e.key === "Enter" && r.options?.[hl] !== undefined) respond({ value: r.options[hl] });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  return (
    <Modal onClose={cancel}>
      <div className="modal-head">
        <div className="modal-icon">
          <Puzzle size={17} />
        </div>
        <div className="grow">
          <h3>{r.title ?? "Extension"}</h3>
          {r.message && <p>{r.message}</p>}
          {name && <p className="faint small">Asked in “{name}”</p>}
        </div>
      </div>
      <div className="modal-body">
        {r.method === "select" &&
          r.options?.map((o, i) => (
            <button key={o} className={`option ${i === hl ? "hl" : ""}`} onMouseEnter={() => setHl(i)} onClick={() => respond({ value: o })}>
              {o}
            </button>
          ))}
        {r.method === "input" && (
          <form onSubmit={(e) => (e.preventDefault(), respond({ value }))}>
            <input className="input" autoFocus placeholder={r.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
          </form>
        )}
        {r.method === "editor" && <textarea className="textarea mono" rows={12} autoFocus value={value} onChange={(e) => setValue(e.target.value)} />}
      </div>
      <div className="modal-foot">
        {left !== undefined && <span className="countdown">Auto-dismisses in {left}s</span>}
        {r.method === "confirm" ? (
          <>
            <button className="btn" onClick={() => respond({ confirmed: false })}>
              No
            </button>
            <button className="btn primary" autoFocus onClick={() => respond({ confirmed: true })}>
              Yes
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
            {(r.method === "input" || r.method === "editor") && (
              <button className="btn primary" onClick={() => respond({ value })}>
                Submit
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- M8: approve each edit before it's applied ----------
function ApprovalDialog({ sessionId, r }: { sessionId: string; r: ApprovalRequest }) {
  const [reason, setReason] = useState("");
  const home = useApp((s) => s.home);
  const decide = (approve: boolean) => {
    useApp.getState().updateChat(sessionId, (c) => ({ ...c, approvals: c.approvals.filter((a) => a.id !== r.id) }));
    void act(req("approvals.decide", { requestId: r.id, approve, reason: reason.trim() || undefined }));
  };
  const isNew = r.original === "" && r.tool === "write";
  return (
    <Modal wide>
      <div className="modal-head">
        <div className="modal-icon warn">
          <ShieldCheck size={17} />
        </div>
        <div className="grow">
          <h3>
            Approve {r.tool === "write" ? (isNew ? "new file" : "overwrite") : "edit"}?
          </h3>
          <p className="mono small">{shortPath(r.path, home)}</p>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
        <DiffEditor original={r.original} modified={r.proposed} language={r.language} path={r.path} />
      </div>
      <div className="modal-foot">
        <input className="input grow" placeholder="Optional note to the agent (e.g. why you reject it)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn danger" onClick={() => decide(false)}>
          Reject
        </button>
        <button className="btn primary" autoFocus onClick={() => decide(true)}>
          Approve
        </button>
      </div>
    </Modal>
  );
}

// ---------- M8: ask_parent from a subagent ----------
function QuestionDialog({ sessionId, q }: { sessionId: string; q: ParentQuestion }) {
  const [answer, setAnswer] = useState("");
  const send = async () => {
    if (!answer.trim()) return;
    if (await act(req("runs.answer", { questionId: q.id, text: answer.trim() })) !== undefined)
      useApp.getState().updateChat(sessionId, (c) => ({ ...c, questions: c.questions.filter((x) => x.id !== q.id) }));
  };
  return (
    <Modal>
      <div className="modal-head">
        <div className="modal-icon">
          <MessageCircleQuestion size={17} />
        </div>
        <div className="grow">
          <h3>{q.from} is asking</h3>
          <p>{q.text}</p>
        </div>
      </div>
      <div className="modal-body">
        <textarea className="textarea" rows={4} autoFocus placeholder="Your answer…" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void send()} />
      </div>
      <div className="modal-foot">
        <span className="countdown">The subagent waits up to 10 minutes.</span>
        <button className="btn primary" disabled={!answer.trim()} onClick={() => void send()}>
          Answer
        </button>
      </div>
    </Modal>
  );
}
