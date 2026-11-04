import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Blocks, Bot, Plug, FolderOpen, FolderTree, GitBranch, PanelLeft, FolderPlus, History, MessageSquare, Network, Play, Plus, RotateCcw, Settings, ShieldCheck, Square, SquareTerminal } from "lucide-react";
import { act, loadProfiles, openSession, pickFolder, recentProjects, req, switchProject, useApp } from "../store.ts";
import { startProfile } from "./TerminalPanel.tsx";
import { MOD, baseName, shortPath, timeAgo } from "./ui.tsx";

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void | Promise<unknown>;
}

/** Subsequence fuzzy score; higher is better, -1 = no match. */
function score(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  let ti = 0;
  let s = 0;
  for (const ch of q) {
    const j = t.indexOf(ch, ti);
    if (j < 0) return -1;
    s += j === ti ? 3 : 1;
    ti = j + 1;
  }
  return s;
}

export function CommandPalette() {
  const st = useApp();
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => useApp.setState({ palette: false });

  useEffect(() => {
    if (st.project) void loadProfiles(st.project);
  }, [st.project]);

  const cmds = useMemo<Cmd[]>(() => {
    const out: Cmd[] = [];
    const active = st.sessions.find((s) => s.id === st.activeId);
    out.push({ id: "new", group: "Actions", label: "New session", hint: `${MOD}N`, icon: <Plus size={15} />, run: async () => (st.project ? openSession(st.project) : openSession((await pickFolder()) ?? "")) });
    out.push({ id: "open", group: "Actions", label: "Open folder…", hint: `${MOD}O`, icon: <FolderPlus size={15} />, run: async () => { const d = await pickFolder(); if (d) switchProject(d); } });
    out.push({ id: "p-files", group: "Panels", label: st.panels.explorer ? "Hide file explorer" : "Show file explorer", hint: `${MOD}B`, icon: <FolderTree size={15} />, run: () => st.setPanels({ explorer: !st.panels.explorer }) });
    out.push({ id: "p-git", group: "Panels", label: st.panels.git ? "Hide source control" : "Show source control", hint: `${MOD}⌥B`, icon: <GitBranch size={15} />, run: () => st.setPanels({ git: !st.panels.git }) });
    out.push({ id: "p-sess", group: "Panels", label: st.panels.sessions ? "Hide sessions sidebar" : "Show sessions sidebar", hint: `${MOD}\\`, icon: <PanelLeft size={15} />, run: () => st.setPanels({ sessions: !st.panels.sessions }) });
    out.push({ id: "term", group: "Actions", label: st.term.open ? "Hide terminal panel" : "Show terminal panel", hint: `${MOD}J`, icon: <SquareTerminal size={15} />, run: () => st.setTerm({ open: !st.term.open }) });
    if (active) {
      out.push({ id: "tab-chat", group: "Session", label: "Go to Chat", hint: `${MOD}1`, icon: <MessageSquare size={15} />, run: () => (st.setPage("session"), st.setTab("chat")) });
      out.push({ id: "tab-runs", group: "Session", label: "Go to Subagents", hint: `${MOD}2`, icon: <Network size={15} />, run: () => (st.setPage("session"), st.setTab("runs")) });
      out.push({ id: "restart", group: "Session", label: "Restart pi for this session", icon: <RotateCcw size={15} />, run: () => act(req("session.restart", { id: active.id }), "Restarted") });
      if (active.status === "streaming") out.push({ id: "abort", group: "Session", label: "Stop the agent", hint: "esc", icon: <Square size={14} />, run: () => act(req("session.abort", { id: active.id })) });
      out.push({ id: "approve", group: "Session", label: "Toggle approve-every-edit", icon: <ShieldCheck size={15} />, run: async () => {
        const cur = await req<{ enabled: boolean }>("approvals.get", { id: active.id });
        await act(req("approvals.setMode", { id: active.id, enabled: !cur.enabled }), cur.enabled ? "Edits apply automatically" : "You'll approve every edit");
      } });
    }
    for (const p of (st.project ? st.profiles[st.project]?.profiles : []) ?? []) {
      const live = st.terminals.find((t) => t.id === p.id);
      if (live?.status !== "running") out.push({ id: `prof-${p.id}`, group: "Terminals", label: `Start ${p.name}`, hint: p.command, icon: <Play size={14} />, run: async () => { const t = await startProfile(st.project!, p); if (t) st.setTerm({ open: true, activeId: t.id }); } });
    }
    for (const t of st.terminals) out.push({ id: `t-${t.id}`, group: "Terminals", label: `Show terminal: ${t.name}`, hint: t.status, icon: <SquareTerminal size={15} />, run: () => st.setTerm({ open: true, activeId: t.id }) });
    for (const s of st.sessions.filter((x) => !x.parentId)) out.push({ id: `s-${s.id}`, group: "Open sessions", label: s.name ?? "New session", hint: baseName(s.cwd), icon: <MessageSquare size={15} />, run: () => st.setActive(s.id) });
    const open = new Set(st.sessions.map((s) => s.sessionFile));
    for (const s of st.stored.filter((x) => !open.has(x.file)).slice(0, 60)) out.push({ id: `r-${s.file}`, group: "Resume", label: s.name ?? s.firstMessage ?? "Session", hint: `${baseName(s.cwd)} · ${timeAgo(s.modified)}`, icon: <History size={15} />, run: () => openSession(s.cwd, s.file) });
    for (const p of recentProjects()) out.push({ id: `sw-${p}`, group: "Projects", label: `Switch to ${baseName(p)}`, hint: shortPath(p, st.home), icon: <FolderOpen size={15} />, run: () => switchProject(p) });
    for (const p of recentProjects()) out.push({ id: `p-${p}`, group: "Projects", label: `New session in ${baseName(p)}`, hint: shortPath(p, st.home), icon: <FolderOpen size={15} />, run: () => openSession(p) });
    out.push({ id: "agents", group: "Go to", label: "Agents", icon: <Bot size={15} />, run: () => st.setPage("agents") });
    out.push({ id: "mcp", group: "Go to", label: "MCP servers", icon: <Plug size={15} />, run: () => st.setPage("mcp") });
    out.push({ id: "extensions", group: "Go to", label: "Extensions", icon: <Blocks size={15} />, run: () => st.setPage("extensions") });
    out.push({ id: "terminals", group: "Go to", label: "Terminal profiles", icon: <SquareTerminal size={15} />, run: () => st.setPage("terminals") });
    out.push({ id: "settings", group: "Go to", label: "Settings", hint: `${MOD},`, icon: <Settings size={15} />, run: () => st.setPage("settings") });
    return out;
  }, [st.sessions, st.stored, st.terminals, st.profiles, st.project, st.activeId, st.term.open, st.panels]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return cmds;
    return cmds
      .map((c) => ({ c, s: Math.max(score(needle, c.label), score(needle, `${c.group} ${c.label} ${c.hint ?? ""}`) - 5) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [q, cmds]);

  useEffect(() => setHl(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".hl")?.scrollIntoView({ block: "nearest" });
  }, [hl]);

  const run = (c?: Cmd) => {
    if (!c) return;
    close();
    void c.run();
  };

  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          placeholder="Type a command, session or project…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setHl((h) => Math.min(results.length - 1, h + 1));
            else if (e.key === "ArrowUp") setHl((h) => Math.max(0, h - 1));
            else if (e.key === "Enter") run(results[hl]);
            else if (e.key === "Escape") close();
            else return;
            e.preventDefault();
          }}
        />
        <div className="palette-list" ref={list}>
          {results.length === 0 && <div className="faint small" style={{ padding: 14 }}>No matches</div>}
          {results.map((c, i) => {
            const header = !q && c.group !== lastGroup ? c.group : undefined;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="palette-group">{header}</div>}
                <button className={`palette-item ${i === hl ? "hl" : ""}`} onMouseMove={() => setHl(i)} onClick={() => run(c)}>
                  <span className="pi-icon">{c.icon}</span>
                  <span className="ellipsis">{c.label}</span>
                  {c.hint && <span className="pi-hint ellipsis" style={{ maxWidth: 220 }}>{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
