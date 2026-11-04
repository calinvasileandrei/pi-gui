import { useMemo, useState } from "react";
import { Blocks, Bot, Plug, ChevronDown, ChevronRight, FolderOpen, FolderPlus, Pencil, Plus, Search, Settings, SquareTerminal, Trash2, X } from "lucide-react";
import type { SessionInfo, StoredSession } from "@pi-gui/protocol";
import { act, confirmDialog, forgetProject, openSession, pickFolder, promptDialog, recentProjects, refreshStored, req, switchProject, useApp, type Page } from "../store.ts";
import { Kbd, MOD, baseName, shortPath, timeAgo } from "./ui.tsx";
import { useMcpSummary } from "../mcp.ts";

interface Row {
  key: string;
  live?: SessionInfo;
  stored?: StoredSession;
  title: string;
  time: string;
}

const PER_PROJECT = 6;

export function Sidebar() {
  const { sessions, stored, activeId, setActive, page, setPage, project, home, conn } = useApp();
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const top = sessions.filter((s) => !s.parentId);
    const projects = new Map<string, Row[]>();
    const add = (cwd: string, r: Row) => (projects.get(cwd) ?? projects.set(cwd, []).get(cwd)!).push(r);
    for (const p of recentProjects()) projects.set(p, []);
    const openFiles = new Set<string>();
    for (const s of top) {
      if (s.sessionFile) openFiles.add(s.sessionFile);
      const st = stored.find((x) => x.file === s.sessionFile);
      add(s.cwd, { key: s.id, live: s, title: s.name ?? st?.name ?? st?.firstMessage ?? "New session", time: st?.modified ?? new Date().toISOString() });
    }
    for (const st of stored) {
      if (openFiles.has(st.file)) continue;
      add(st.cwd, { key: st.file, stored: st, title: st.name ?? st.firstMessage ?? "Empty session", time: st.modified });
    }
    const needle = q.trim().toLowerCase();
    return [...projects.entries()]
      .map(([cwd, rows]) => ({
        cwd,
        rows: rows
          .filter((r) => !needle || r.title.toLowerCase().includes(needle) || cwd.toLowerCase().includes(needle))
          .sort((a, b) => Number(!!b.live) - Number(!!a.live) || b.time.localeCompare(a.time)),
        last: rows.reduce((m, r) => (r.time > m ? r.time : m), ""),
      }))
      .filter((g) => !needle || g.rows.length)
      .sort((a, b) => Number(b.cwd === project) - Number(a.cwd === project) || b.last.localeCompare(a.last))
      .slice(0, 20);
  }, [sessions, stored, q, project]);

  async function newSession(cwd?: string) {
    const dir = cwd ?? project ?? (await pickFolder());
    if (dir) await openSession(dir);
  }
  async function openFolder() {
    const dir = await pickFolder();
    if (dir) switchProject(dir);
  }
  async function rename(r: Row) {
    const name = await promptDialog({ title: "Rename session", value: r.title, confirm: "Rename" });
    if (!name) return;
    if (r.live) await act(req("session.rename", { id: r.live.id, name }));
    else if (r.stored) await act(req("stored.rename", { file: r.stored.file, name }));
    void refreshStored();
  }
  async function remove(r: Row) {
    if (r.live && !r.live.sessionFile) {
      await act(req("session.close", { id: r.live.id }));
      return;
    }
    const file = r.live?.sessionFile ?? r.stored?.file;
    if (!file) return;
    const ok = await confirmDialog({ title: "Delete session?", body: `“${r.title}” will be moved to ~/.pi-gui/trash. It disappears from pi in the terminal too.`, confirm: "Delete", danger: true });
    if (ok) {
      await act(req("stored.delete", { file }), "Session deleted");
      void refreshStored();
    }
  }
  function open(r: Row) {
    if (r.live) setActive(r.live.id);
    else if (r.stored) void openSession(r.stored.cwd, r.stored.file);
  }

  const nav: { page: Page; label: string; icon: React.ReactNode }[] = [
    { page: "agents", label: "Agents", icon: <Bot size={15} /> },
    { page: "mcp", label: "MCP servers", icon: <Plug size={15} /> },
    { page: "extensions", label: "Extensions", icon: <Blocks size={15} /> },
    { page: "terminals", label: "Terminal profiles", icon: <SquareTerminal size={15} /> },
    { page: "settings", label: "Settings", icon: <Settings size={15} /> },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <div className="brand">
          <span className="brand-mark">π</span>
          pi
        </div>
      </div>
      <div className="sidebar-actions">
        <button className="side-btn" onClick={() => void newSession()} title="New session in the current project">
          <Plus size={15} /> New session <Kbd>{MOD}N</Kbd>
        </button>
        <button className="side-btn" onClick={() => void openFolder()}>
          <FolderPlus size={15} /> Open folder…
        </button>
        <div className="side-search">
          <Search size={14} />
          <input className="input" placeholder="Search sessions" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="side-scroll">
        {groups.length === 0 && <div className="faint small" style={{ padding: "12px 10px" }}>Open a project folder to start.</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed[g.cwd];
          const rows = expanded[g.cwd] ? g.rows : g.rows.slice(0, PER_PROJECT);
          return (
            <div className="project" key={g.cwd}>
              <div className={`project-head ${g.cwd === project ? "focused" : ""}`} onClick={() => (g.cwd === project ? setCollapsed({ ...collapsed, [g.cwd]: !isCollapsed }) : switchProject(g.cwd))} title={`${shortPath(g.cwd, home)} — click to focus this project`}>
                <span className="chev-btn" onClick={(e) => (e.stopPropagation(), setCollapsed({ ...collapsed, [g.cwd]: !isCollapsed }))}>
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </span>
                <FolderOpen size={14} />
                <span className="ellipsis">{baseName(g.cwd)}</span>
                <span className="project-actions">
                  <button className="icon-btn" title="New session here" onClick={(e) => (e.stopPropagation(), void newSession(g.cwd))}>
                    <Plus size={13} />
                  </button>
                  {g.rows.length === 0 && (
                    <button className="icon-btn" title="Remove from list" onClick={(e) => (e.stopPropagation(), forgetProject(g.cwd), useApp.setState({}))}>
                      <X size={13} />
                    </button>
                  )}
                </span>
              </div>
              {!isCollapsed &&
                rows.map((r) => {
                  const active = !!r.live && r.live.id === activeId && page === "session";
                  return (
                    <div key={r.key} className={`sess ${active ? "active" : ""}`} onClick={() => open(r)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(r)}>
                      <span className={`dot ${r.live ? r.live.status : "stopped"}`} style={r.live ? undefined : { opacity: 0.35 }} />
                      <span className="sess-name">{r.title}</span>
                      <span className="sess-time">{timeAgo(r.time)}</span>
                      <span className="sess-menu row" style={{ gap: 0 }}>
                        <button className="icon-btn" title="Rename" onClick={(e) => (e.stopPropagation(), void rename(r))}>
                          <Pencil size={12} />
                        </button>
                        <button className="icon-btn" title={r.live && !r.live.sessionFile ? "Close" : "Delete"} onClick={(e) => (e.stopPropagation(), void remove(r))}>
                          {r.live && !r.live.sessionFile ? <X size={12} /> : <Trash2 size={12} />}
                        </button>
                      </span>
                    </div>
                  );
                })}
              {!isCollapsed && g.rows.length > PER_PROJECT && (
                <button className="side-more" onClick={() => setExpanded({ ...expanded, [g.cwd]: !expanded[g.cwd] })}>
                  {expanded[g.cwd] ? "Show less" : `Show ${g.rows.length - PER_PROJECT} more`}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="sidebar-foot">
        {nav.map((n) => (
          <button key={n.page} className={`side-btn ${page === n.page ? "active" : ""}`} onClick={() => setPage(n.page)}>
            {n.icon} {n.label}
            {n.page === "mcp" && <McpBadge project={project} />}
          </button>
        ))}
        <div className="conn-pill">
          <span className={`dot ${conn === "open" ? "idle" : "starting"}`} />
          {conn === "open" ? "Connected" : "Reconnecting…"}
          <span style={{ marginLeft: "auto" }}>
            <Kbd>{MOD}K</Kbd>
          </span>
        </div>
      </div>
    </aside>
  );
}

function McpBadge({ project }: { project?: string }) {
  const m = useMcpSummary(project);
  if (!m.total) return null;
  return (
    <span className={`side-badge ${m.failing ? "err" : ""}`} title={`${m.connected}/${m.total} connected${m.failing ? `, ${m.failing} failing` : ""} · ${m.tools} tools`}>
      {m.failing ? `${m.failing} !` : m.connected ? `${m.connected}/${m.total}` : m.total}
    </span>
  );
}
