import { useState } from "react";
import { Network, Send, StickyNote } from "lucide-react";
import type { ChatState } from "../chat-state.ts";
import { act, req, useApp } from "../store.ts";
import { SubagentCard } from "./SubagentCard.tsx";
import { Empty, timeAgo } from "./ui.tsx";

export function RunsView({ id, chat }: { id: string; chat: ChatState }) {
  const [note, setNote] = useState("");
  const setPage = useApp((s) => s.setPage);
  const runs = [...chat.runs].sort((a, b) => (b.startedAt ?? Infinity) - (a.startedAt ?? Infinity));
  return (
    <div className="runs">
      <div className="runs-list">
        {runs.length === 0 ? (
          <Empty icon={<Network size={22} />} title="No subagents yet">
            <p>Ask pi to delegate, e.g. “use two scout subagents in parallel to map the auth flow and the API layer”.</p>
            <button className="btn" onClick={() => setPage("agents")}>
              Manage agents
            </button>
          </Empty>
        ) : (
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            {runs.map((r) => (
              <SubagentCard key={r.id} run={r} sessionId={id} defaultOpen={r.status !== "running"} />
            ))}
          </div>
        )}
      </div>
      <div className="runs-side">
        <div className="runs-side-head">
          <StickyNote size={15} /> Blackboard <span className="badge">{chat.notes.length}</span>
        </div>
        <div className="notes">
          {chat.notes.length === 0 && <div className="faint small">Shared notes from the parent and its subagents appear here, live.</div>}
          {chat.notes.map((n) => (
            <div className="note" key={n.id}>
              <div className="who">
                {n.author} <span className="faint">{timeAgo(n.ts)}</span>
              </div>
              {n.text}
            </div>
          ))}
        </div>
        <form
          className="note-add"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!note.trim()) return;
            if (await act(req("runs.noteAppend", { id, text: note }))) setNote("");
          }}
        >
          <input className="input" placeholder="Add a note for the agents…" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="icon-btn" type="submit" disabled={!note.trim()} aria-label="Add note">
            <Send size={14} />
          </button>
        </form>
      </div>
    </div>
  );
}
