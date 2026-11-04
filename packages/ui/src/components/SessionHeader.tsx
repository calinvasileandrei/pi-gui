import { useEffect, useState } from "react";
import { THINKING_LEVELS, type Model, type SessionStats, type ThinkingLevel } from "@pi-gui/protocol";
import type { ChatState } from "../chat-state.ts";
import { req } from "../store.ts";

export function SessionHeader({ id, chat }: { id: string; chat: ChatState }) {
  const [models, setModels] = useState<Model[]>([]);
  const [stats, setStats] = useState<SessionStats>();
  const [err, setErr] = useState<string>();
  const running = chat.info?.status === "idle" || chat.info?.status === "streaming";
  const model = chat.state?.model;
  const msgCount = chat.messages.length;

  useEffect(() => {
    if (!running) return;
    req<Model[]>("session.models", { id }).then(setModels, () => {});
  }, [id, running]);
  useEffect(() => {
    if (!running || chat.info?.status === "streaming") return;
    req<SessionStats>("session.stats", { id }).then(setStats, () => {});
  }, [id, running, msgCount, chat.info?.status]);

  const key = model && model.provider !== "unknown" ? `${model.provider}/${model.id}` : "";
  const ctx = stats?.contextUsage;

  return (
    <div className="header">
      <div className="header-title">
        <span className={`dot st-${chat.info?.status}`} title={chat.info?.status} />
        <strong>{chat.info?.name ?? "Untitled session"}</strong>
        <span className="muted small">{chat.info?.cwd}</span>
      </div>
      <div className="header-controls">
        <select
          value={key}
          disabled={!running || models.length === 0}
          title={models.length === 0 ? "No models: log in to a provider with `pi` → /login" : "Model"}
          onChange={async (e) => {
            const [provider, ...rest] = e.target.value.split("/");
            try {
              setErr(undefined);
              await req("session.setModel", { id, provider, modelId: rest.join("/") });
            } catch (x) {
              setErr((x as Error).message);
            }
          }}
        >
          {!key && <option value="">{models.length ? "Select model" : "No models available"}</option>}
          {key && !models.some((m) => `${m.provider}/${m.id}` === key) && <option value={key}>{key}</option>}
          {groupBy(models, (m) => m.provider).map(([prov, ms]) => (
            <optgroup key={prov} label={prov}>
              {ms.map((m) => (
                <option key={m.id} value={`${m.provider}/${m.id}`}>
                  {m.name || m.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          value={chat.state?.thinkingLevel ?? "off"}
          disabled={!running || !model?.reasoning}
          title="Thinking level"
          onChange={(e) => void req("session.setThinking", { id, level: e.target.value as ThinkingLevel }).catch((x) => setErr(x.message))}
        >
          {THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>
              think: {l}
            </option>
          ))}
        </select>
        {ctx && (
          <div className="meter" title={`${ctx.tokens ?? "?"} / ${ctx.contextWindow} tokens in context`}>
            <div className="meter-bar" style={{ width: `${Math.min(100, ctx.percent ?? 0)}%` }} />
            <span>{ctx.percent == null ? "ctx ?" : `ctx ${Math.round(ctx.percent)}%`}</span>
          </div>
        )}
        {stats && stats.cost > 0 && <span className="muted small">${stats.cost.toFixed(3)}</span>}
      </div>
      {err && <div className="err small">{err}</div>}
    </div>
  );
}

function groupBy<T>(xs: T[], k: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x]);
  return [...m.entries()];
}
