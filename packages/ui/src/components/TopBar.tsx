import { useEffect, useState } from "react";
import { MessageSquare, Minimize2, Network, RotateCcw, ShieldCheck, SquareTerminal } from "lucide-react";
import { THINKING_LEVELS, type Model, type SessionStats, type ThinkingLevel } from "@pi-gui/protocol";
import type { ChatState } from "../chat-state.ts";
import { act, req, useApp } from "../store.ts";

interface HarnessList {
  default: "pi" | "claude";
  harnesses: { id: "pi" | "claude"; name: string; available: boolean; models?: Model[] }[];
}
const PROVIDER_LABEL: Record<string, string> = { "claude-code": "Claude Code · your plan" };
const PERMISSION_MODES: [string, string][] = [
  ["default", "Ask before acting"],
  ["acceptEdits", "Auto-accept edits"],
  ["plan", "Plan only"],
  ["bypassPermissions", "Don't ask"],
];

/** Picking a model from the other agent: empty sessions switch, others open a new session next to it. */
async function switchHarness(id: string, harness: "pi" | "claude", model?: string) {
  const r = await act(req<{ info: { id: string }; replaced: boolean }>("session.switchHarness", { id, harness, model }));
  if (!r) return;
  useApp.getState().setActive(r.info.id);
  if (!r.replaced) useApp.getState().toast("info", `Started a new ${harness === "claude" ? "Claude Code" : "pi"} session — a conversation can't move between agents, the old one is still in the sidebar.`);
}
import { Kbd, MOD, shortPath } from "./ui.tsx";
import { LeftToggles, RightToggle } from "./Layout.tsx";

export function TopBar({ id, chat }: { id: string; chat: ChatState }) {
  const { tab, setTab, term, setTerm, home } = useApp();
  const [models, setModels] = useState<Model[]>([]);
  const [stats, setStats] = useState<SessionStats>();
  const [approvals, setApprovals] = useState(false);
  const [harnesses, setHarnesses] = useState<HarnessList>();
  const isClaude = chat.info?.harness === "claude";
  const claude = harnesses?.harnesses.find((h) => h.id === "claude" && h.available);
  const status = chat.info?.status;
  const running = status === "idle" || status === "streaming";
  const model = chat.state?.model;
  const activeRuns = chat.runs.filter((r) => r.status === "running" || r.status === "queued").length;

  useEffect(() => {
    if (!running) return;
    req<Model[]>("session.models", { id }).then(setModels, () => {});
    if (!isClaude) req<{ enabled: boolean }>("approvals.get", { id }).then((r) => setApprovals(r.enabled), () => {});
  }, [id, running, isClaude]);
  useEffect(() => {
    req<HarnessList>("harness.list").then(setHarnesses, () => {});
  }, []);
  useEffect(() => {
    if (!running || status === "streaming") return;
    req<SessionStats>("session.stats", { id }).then(setStats, () => {});
  }, [id, running, chat.messages.length, status]);

  const key = model && model.provider !== "unknown" ? `${model.provider}/${model.id}` : "";
  const ctx = stats?.contextUsage;
  const pct = ctx?.percent ?? 0;
  const byProvider = new Map<string, Model[]>();
  for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);

  return (
    <div className="topbar drag">
      <LeftToggles />
      <div className="topbar-title">
        <span className={`dot ${status}`} title={status} />
        <h1>{chat.info?.name ?? "New session"}</h1>
        <span className="path-chip" title={chat.info?.cwd}>
          {shortPath(chat.info?.cwd ?? "", home)}
        </span>
      </div>
      <div className="seg no-drag">
        <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
          <MessageSquare size={13} /> Chat
        </button>
        <button className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>
          <Network size={13} /> Subagents {chat.runs.length > 0 && <span className={`badge ${activeRuns ? "accent" : ""}`}>{activeRuns || chat.runs.length}</span>}
        </button>
      </div>
      <div className="topbar-right">
        <select
          className="select compact"
          value={key}
          disabled={!running || models.length === 0}
          title={models.length === 0 ? (isClaude ? "Waiting for Claude Code…" : "No models — log in to a provider in pi (/login)") : "Model"}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("@")) {
              const [h, ...m] = v.slice(1).split("/");
              void switchHarness(id, h as "pi" | "claude", m.join("/") || undefined);
              return;
            }
            const [provider, ...rest] = v.split("/");
            void act(req("session.setModel", { id, provider, modelId: rest.join("/") }));
          }}
        >
          {!key && <option value="">{models.length ? "Select model" : "No models"}</option>}
          {key && !models.some((m) => `${m.provider}/${m.id}` === key) && <option value={key}>{model?.name ?? key}</option>}
          {[...byProvider.entries()].map(([prov, ms]) => (
            <optgroup key={prov} label={PROVIDER_LABEL[prov] ?? prov}>
              {ms.map((m) => (
                <option key={m.id} value={`${m.provider}/${m.id}`}>
                  {m.name || m.id}
                </option>
              ))}
            </optgroup>
          ))}
          {!isClaude && claude && (
            <optgroup label="Claude Code · your plan (new session)">
              {(claude.models ?? []).map((m) => (
                <option key={m.id} value={`@claude/${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
          {isClaude && (
            <optgroup label="pi (new session)">
              <option value="@pi/">pi · default model</option>
            </optgroup>
          )}
        </select>
        {model?.reasoning && (
          <select
            className="select compact"
            value={chat.state?.thinkingLevel || (isClaude ? "" : "off")}
            disabled={!running}
            title={isClaude ? "Effort" : "Thinking level"}
            onChange={(e) => void act(req("session.setThinking", { id, level: e.target.value as ThinkingLevel }))}
          >
            {isClaude && !chat.state?.thinkingLevel && <option value="">Effort: default</option>}
            {((model.thinkingLevels as string[] | undefined) ?? THINKING_LEVELS).map((l) => (
              <option key={l} value={l}>
                {isClaude ? "Effort" : "Think"}: {l}
              </option>
            ))}
          </select>
        )}
        {isClaude && (
          <select
            className="select compact"
            value={chat.state?.permissionMode ?? "default"}
            disabled={!running}
            title="When Claude asks before using tools"
            onChange={(e) => void act(req("session.setPermissionMode", { id, mode: e.target.value }))}
          >
            {[...PERMISSION_MODES, ...(PERMISSION_MODES.some(([m]) => m === chat.state?.permissionMode) || !chat.state?.permissionMode ? [] : [[chat.state.permissionMode, chat.state.permissionMode] as [string, string]])].map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </select>
        )}
        {isClaude && chat.state?.planUsage && (
          <span
            className={`plan-chip ${chat.state.planUsage.overage ? "warn" : ""}`}
            title={`Claude plan usage${chat.state.planUsage.resetsAt ? ` · resets ${new Date(chat.state.planUsage.resetsAt * 1000).toLocaleString()}` : ""}${chat.state.planUsage.overage ? " · plan limit reached, using extra usage" : " · running on your plan, not extra usage"}`}
          >
            {chat.state.planUsage.overage ? "extra usage" : chat.state.planUsage.text}
          </span>
        )}
        {ctx && (
          <div className="meter" title={`${ctx.tokens?.toLocaleString() ?? "?"} / ${ctx.contextWindow.toLocaleString()} tokens in context${stats?.cost ? ` · $${stats.cost.toFixed(3)}` : ""}`}>
            <div className="meter-track">
              <div className={`meter-fill ${pct > 85 ? "err" : pct > 65 ? "warn" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            {ctx.percent == null ? "—" : `${Math.round(pct)}%`}
          </div>
        )}
        {!isClaude && <button
          className={`icon-btn ${approvals ? "active" : ""}`}
          title={approvals ? "Approve-every-edit is ON (click to turn off)" : "Approve every edit before it's applied"}
          disabled={!running}
          onClick={async () => {
            const r = await act(req<{ enabled: boolean }>("approvals.setMode", { id, enabled: !approvals }));
            if (r) setApprovals(r.enabled);
          }}
        >
          <ShieldCheck size={16} />
        </button>}
        <button className="icon-btn" title="Compact context" disabled={!running || status === "streaming"} onClick={() => void act(req("session.compact", { id }), "Context compacted")}>
          <Minimize2 size={15} />
        </button>
        <button className="icon-btn" title={isClaude ? "Restart Claude Code for this session" : "Restart pi for this session"} onClick={() => void act(req("session.restart", { id }), "Session restarted")}>
          <RotateCcw size={15} />
        </button>
        <button className={`icon-btn ${term.open ? "active" : ""}`} title={`Terminal panel (${MOD}J)`} onClick={() => setTerm({ open: !term.open })}>
          <SquareTerminal size={16} />
        </button>
        <RightToggle />
      </div>
    </div>
  );
}

export { Kbd };
