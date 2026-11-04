import { memo, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { Brain, ChevronRight, Sparkles } from "lucide-react";
import type { AgentMessage, AssistantMessage, SubagentRun } from "@pi-gui/protocol";
import { resultsById, type ChatState } from "../chat-state.ts";
import { renderMarkdown } from "../markdown.ts";
import { ToolCard } from "./ToolCard.tsx";
import { Empty } from "./ui.tsx";

type Item = { key: string; msg: AgentMessage; live?: boolean } | { key: string; typing: true };

/** Virtualized message list (also used read-only for subagent transcripts). */
export function MessageList({ chat, sessionId, onOpenDiff, empty }: { chat: ChatState; sessionId: string; onOpenDiff?: (p: string) => void; empty?: React.ReactNode }) {
  const results = useMemo(() => resultsById(chat.messages), [chat.messages]);
  const runsByCall = useMemo(() => new Map(chat.runs.filter((r) => r.toolCallId).map((r) => [r.toolCallId!, r])), [chat.runs]);
  const items = useMemo<Item[]>(() => {
    const xs: Item[] = chat.messages.map((m, i) => ({ key: `${i}-${m.timestamp}`, msg: m })).filter((x) => x.msg.role !== "toolResult");
    if (chat.streaming) xs.push({ key: "live", msg: chat.streaming, live: true });
    else if (chat.info?.status === "streaming") xs.push({ key: "typing", typing: true });
    return xs;
  }, [chat.messages, chat.streaming, chat.info?.status]);

  if (!chat.loaded) return <div className="empty-state"><span className="spinner" /></div>;
  if (items.length === 0) return <>{empty ?? null}</>;

  return (
    <Virtuoso
      className="chat"
      data={items}
      computeItemKey={(_, it) => it.key}
      followOutput={(atBottom) => (atBottom ? "smooth" : false)}
      initialTopMostItemIndex={items.length - 1}
      increaseViewportBy={{ top: 900, bottom: 400 }}
      components={{ Header: () => <div className="chat-top-spacer" />, Footer: () => <div style={{ height: 12 }} /> }}
      itemContent={(_, it) => (
        <div className="chat-row">
          <div className="chat-inner">
            {"typing" in it ? (
              <div className="msg-assistant">
                <span className="avatar">π</span>
                <div className="typing"><i /><i /><i /></div>
              </div>
            ) : (
              <Message msg={it.msg} live={it.live} chat={chat} results={results} runsByCall={runsByCall} sessionId={sessionId} onOpenDiff={onOpenDiff} />
            )}
          </div>
        </div>
      )}
    />
  );
}

export function ChatView({ chat, sessionId, onOpenDiff }: { chat: ChatState; sessionId: string; onOpenDiff?: (p: string) => void }) {
  return (
    <MessageList
      chat={chat}
      sessionId={sessionId}
      onOpenDiff={onOpenDiff}
      empty={
        <Empty icon={<Sparkles size={22} />} title="What should pi work on?">
          <p>Describe a task. pi reads, edits and runs code in this folder.</p>
          <p className="faint small">Tip: start a line with ! to run a shell command, ⌘K for commands.</p>
        </Empty>
      }
    />
  );
}

interface MsgProps {
  msg: AgentMessage;
  live?: boolean;
  chat: ChatState;
  results: ReturnType<typeof resultsById>;
  runsByCall: Map<string, SubagentRun>;
  sessionId: string;
  onOpenDiff?: (p: string) => void;
}

const Message = memo(function Message(p: MsgProps) {
  const { msg } = p;
  switch (msg.role) {
    case "user": {
      const t = typeof msg.content === "string" ? msg.content : msg.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
      return (
        <div className="msg-user" style={{ margin: "14px 0 6px" }}>
          <div className="bubble">{t}</div>
        </div>
      );
    }
    case "assistant":
      return <Assistant {...p} msg={msg} />;
    case "bashExecution":
      return (
        <div className="tool" style={{ margin: "10px 0" }}>
          <div className="tool-head" style={{ cursor: "default" }}>
            <span className="tool-icon">$</span>
            <span className="tool-sum" style={{ color: "var(--text)" }}>{String(msg.command)}</span>
            {typeof msg.exitCode === "number" && msg.exitCode !== 0 && <span className="badge err">exit {msg.exitCode}</span>}
          </div>
          <div className="tool-body">
            <pre className="tool-pre">{String(msg.output ?? "")}</pre>
          </div>
        </div>
      );
    case "compactionSummary":
    case "branchSummary":
      return (
        <div className="msg-system" style={{ margin: "12px 0" }}>
          <span className="pill">{msg.role === "compactionSummary" ? "Context compacted — earlier messages summarised" : "Branch summary"}</span>
        </div>
      );
    case "custom":
      return msg.display ? (
        <div className="msg-system" style={{ margin: "8px 0" }}>
          <span className="pill">{typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}</span>
        </div>
      ) : null;
    default:
      return null;
  }
});

function Assistant({ msg, live, chat, results, runsByCall, sessionId, onOpenDiff }: MsgProps & { msg: AssistantMessage }) {
  const blocks = msg.content;
  const hasText = blocks.some((c) => c.type === "text" && c.text.trim());
  return (
    <div className="msg-assistant" style={{ margin: "10px 0" }}>
      <span className="avatar">π</span>
      <div className="msg-body">
        {blocks.map((c, i) => {
          if (c.type === "text") return c.text ? <Markdown key={i} text={c.text} /> : null;
          if (c.type === "thinking") return c.thinking.trim() ? <Thinking key={i} text={c.thinking} live={!!live && i === blocks.length - 1} /> : null;
          if (c.type === "toolCall")
            return <ToolCard key={c.id} call={c} run={chat.tools[c.id]} result={results.get(c.id)} subRun={runsByCall.get(c.id)} sessionId={sessionId} onOpenDiff={onOpenDiff} />;
          return null;
        })}
        {live && !hasText && blocks.length === 0 && <div className="typing"><i /><i /><i /></div>}
        {live && hasText && <span className="cursor-blink" />}
        {msg.stopReason === "error" && <div className="msg-error">{msg.errorMessage ?? "The model returned an error."}</div>}
        {msg.stopReason === "aborted" && <div className="msg-meta">Stopped</div>}
      </div>
    </div>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const show = open || live;
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <Brain size={13} /> {live ? "Thinking…" : "Thought process"}
        <ChevronRight size={12} className={`tool-chev ${show ? "open" : ""}`} />
      </button>
      {show && <div className="thinking-body">{text}</div>}
    </div>
  );
}
