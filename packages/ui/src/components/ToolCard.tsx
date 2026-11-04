import { useState, type ReactNode } from "react";
import { ChevronRight, FilePen, FilePlus2, FileText, FolderTree, MessageCircleQuestion, Network, Search, SquareTerminal, StickyNote, Terminal, Wrench } from "lucide-react";
import type { SubagentRun, ToolCall, ToolResult, ToolResultMessage } from "@pi-gui/protocol";
import type { ToolRun } from "../chat-state.ts";
import { SubagentCard } from "./SubagentCard.tsx";

const textOf = (r?: ToolResult | ToolResultMessage) => (r?.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("");
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

const ICONS: Record<string, ReactNode> = {
  bash: <Terminal size={13} />,
  read: <FileText size={13} />,
  edit: <FilePen size={13} />,
  write: <FilePlus2 size={13} />,
  grep: <Search size={13} />,
  find: <Search size={13} />,
  ls: <FolderTree size={13} />,
  subagent: <Network size={13} />,
  terminal_read: <SquareTerminal size={13} />,
  notes_read: <StickyNote size={13} />,
  notes_append: <StickyNote size={13} />,
  ask_parent: <MessageCircleQuestion size={13} />,
};

function summary(name: string, a: Record<string, unknown>): string {
  switch (name) {
    case "bash":
      return str(a.command);
    case "read": {
      const range = a.offset ? ` :${a.offset}${a.limit ? `-${Number(a.offset) + Number(a.limit)}` : ""}` : "";
      return str(a.path) + range;
    }
    case "write":
    case "edit":
    case "ls":
      return str(a.path ?? ".");
    case "grep":
    case "find":
      return `${str(a.pattern)}${a.path ? `  in ${str(a.path)}` : ""}`;
    case "terminal_read":
      return `${str(a.name)}${a.lines ? ` · ${a.lines} lines` : ""}`;
    case "notes_append":
    case "message_parent":
      return str(a.text);
    case "ask_parent":
      return str(a.question);
    default: {
      const s = JSON.stringify(a);
      return s === "{}" ? "" : s.length > 140 ? s.slice(0, 137) + "…" : s;
    }
  }
}

type ToolCardProps = { call: ToolCall; run?: ToolRun; result?: ToolResultMessage; subRun?: SubagentRun; sessionId: string; onOpenDiff?: (path: string) => void };

export function ToolCard(props: ToolCardProps) {
  if (props.call.name === "subagent" && props.subRun) return <SubagentCard run={props.subRun} sessionId={props.sessionId} />;
  return <PlainToolCard {...props} />;
}

function PlainToolCard(props: ToolCardProps) {
  const { call, run, result } = props;
  const status = run?.status ?? (result ? (result.isError ? "error" : "done") : "pending");
  const [open, setOpen] = useState(status === "error");
  const output = textOf(run?.result ?? run?.partial ?? result);
  const path = str(call.arguments.path);
  const isFileEdit = (call.name === "edit" || call.name === "write") && !!path;
  const showArgs = !["bash", "read", "ls", "grep", "find", "edit", "write", "terminal_read"].includes(call.name) && Object.keys(call.arguments).length > 0;

  return (
    <div className={`tool tool-${status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-icon">{status === "running" ? <span className="spinner" style={{ width: 11, height: 11 }} /> : (ICONS[call.name] ?? <Wrench size={13} />)}</span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-sum">{summary(call.name, call.arguments)}</span>
        {status === "error" && <span className="badge err">failed</span>}
        {call.name === "edit" && Array.isArray(call.arguments.edits) && <span className="badge">{(call.arguments.edits as unknown[]).length} edit{(call.arguments.edits as unknown[]).length === 1 ? "" : "s"}</span>}
        <ChevronRight size={14} className={`tool-chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="tool-body">
          {isFileEdit && props.onOpenDiff && (
            <div className="tool-actions">
              <button className="btn sm" onClick={() => props.onOpenDiff!(path)}>
                Open full diff
              </button>
            </div>
          )}
          {call.name === "edit" && Array.isArray(call.arguments.edits) ? (
            <MiniDiff edits={call.arguments.edits as { oldText: string; newText: string }[]} />
          ) : call.name === "write" ? (
            <pre className="tool-pre">{clip(str(call.arguments.content))}</pre>
          ) : showArgs ? (
            <>
              <div className="tool-section">Arguments</div>
              <pre className="tool-pre">{JSON.stringify(call.arguments, null, 2)}</pre>
            </>
          ) : null}
          {output && (
            <>
              {(showArgs || call.name === "edit" || call.name === "write") && <div className="tool-section">Result</div>}
              <pre className={`tool-pre ${status === "error" ? "err" : ""}`}>{clip(output)}</pre>
            </>
          )}
          {!output && status === "running" && <div className="tool-pre faint">running…</div>}
        </div>
      )}
    </div>
  );
}

export function MiniDiff({ edits }: { edits: { oldText: string; newText: string }[] }) {
  return (
    <div className="diff-mini">
      {edits.map((e, i) => (
        <div key={i} className="hunk">
          {e.oldText.split("\n").map((l, j) => (
            <div key={`o${j}`} className="l del">
              {l || " "}
            </div>
          ))}
          {e.newText.split("\n").map((l, j) => (
            <div key={`n${j}`} className="l add">
              {l || " "}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const MAX = 20000;
const clip = (s: string) => (s.length > MAX ? s.slice(0, MAX) + `\n… (${(s.length - MAX).toLocaleString()} more chars)` : s);
