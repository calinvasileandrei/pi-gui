import { useEffect, useMemo, useState } from "react";
import { Blocks, Bot, Plug, ChevronDown, ChevronRight, FolderOpen, FolderPlus, GitBranch, GitBranchPlus, Pencil, Plus, Search, Settings, SquareTerminal, Trash2, X } from "lucide-react";
import type { WorktreeInfo, WorktreeRepo } from "@pi-gui/protocol";
import type { SessionInfo, StoredSession } from "@pi-gui/protocol";
import { act, confirmDialog, forgetProject, openSession, pickFolder, projectOrder, promptDialog, recentProjects, setProjectOrder, refreshStored, req, switchProject, useApp, type Page } from "../store.ts";
import { Kbd, MOD, baseName, shortPath, timeAgo } from "./ui.tsx";
import { useMcpSummary } from "../mcp.ts";
import { useWorktreeSync, useWorktrees, worktreeOf } from "../worktrees.ts";
import { newWorktreeDialog, removeWorktreeDialog } from "./WorktreeDialogs.tsx";

interface Row {
  key: string;
  live?: SessionInfo;
  stored?: StoredSession;
  title: string;
  time: string;
}

const PER_PROJECT = 6;

interface Sub {
  path: string;
  wt?: WorktreeInfo;
  rows: Row[];
}
interface RepoGroup {
  key: string;
  repo?: WorktreeRepo;
  last: string;
  subs: Map<string, Sub>;
}

export function Sidebar() {
  const { sessions, stored, activeId, setActive, page, setPage, project, home, conn } = useApp();
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [order, setOrder] = useState(projectOrder);
  const [drag, setDrag] = useState<{ key: string; over?: string; after?: boolean }>();

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
      .filter((g) => !needle || g.rows.length);
  }, [sessions, stored, q]);

  // ---- group folders by git repo: one entry per repo, its worktrees as sub-sections ----
  useWorktreeSync(useMemo(() => [...groups.map((g) => g.cwd), ...(project ? [project] : [])], [groups, project]));
  const byDir = useWorktrees((s) => s.byDir);
  const repos = useMemo(() => {
    const out = new Map<string, RepoGroup>();
    const needle = q.trim().toLowerCase();
    const cwds = [...groups.map((g) => g.cwd), ...(project && !groups.some((g) => g.cwd === project) ? [project] : [])];
    for (const cwd of cwds) {
      const g = groups.find((x) => x.cwd === cwd) ?? { cwd, rows: [], last: "" };
      const hit = worktreeOf(cwd, byDir);
      const key = hit?.repo.repo ?? cwd;
      let rg = out.get(key);
      if (!rg) out.set(key, (rg = { key, repo: hit?.repo, last: "", subs: new Map() }));
      const sub = hit?.wt.path ?? cwd;
      const cur = rg.subs.get(sub) ?? { path: sub, wt: hit?.wt, rows: [] };
      cur.rows.push(...g.rows);
      rg.subs.set(sub, cur);
      if (g.last > rg.last) rg.last = g.last;
    }
    // worktrees without any session still show up (made in a terminal, or just created)
    for (const rg of out.values()) {
      for (const w of rg.repo?.worktrees ?? []) if (!rg.subs.has(w.path) && !needle) rg.subs.set(w.path, { path: w.path, wt: w, rows: [] });
      for (const sub of rg.subs.values()) sub.rows.sort((a, b) => Number(!!b.live) - Number(!!a.live) || b.time.localeCompare(a.time));
    }
    // a stable, user-defined order: focusing a project only highlights it. Projects not placed yet go on top, newest first.
    const pos = (rg: RepoGroup) => {
      const i = order.indexOf(rg.key);
      return i < 0 ? -1 : i;
    };
    return [...out.values()]
      .filter((rg) => !needle || [...rg.subs.values()].some((s) => s.rows.length))
      .sort((a, b) => pos(a) - pos(b) || b.last.localeCompare(a.last))
      .slice(0, 20);
  }, [groups, byDir, project, q, order]);

  // pin newly seen projects into the saved order so they stay put from now on
  useEffect(() => {
    const saved = projectOrder();
    const fresh = repos.map((r) => r.key).filter((k) => !saved.includes(k));
    if (!fresh.length) {
      if (saved.join("\n") !== order.join("\n")) setOrder(saved);
      return;
    }
    const next = [...fresh, ...saved];
    setProjectOrder(next);
    setOrder(next);
  }, [repos, order]);

  function moveProject(key: string, target: string, after: boolean) {
    if (key === target) return;
    const visible = repos.map((r) => r.key);
    const base = [...visible, ...projectOrder().filter((k) => !visible.includes(k))].filter((k) => k !== key);
    const i = base.indexOf(target);
    base.splice(i < 0 ? base.length : i + (after ? 1 : 0), 0, key);
    setProjectOrder(base);
    setOrder(base);
  }

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
    const ok = await confirmDialog({ title: "Delete session?", body: `“${r.title}” will be moved to ~/.pi-gui/trash. ${(r.live?.harness ?? r.stored?.harness) === "claude" ? "It disappears from Claude Code's /resume too." : "It disappears from pi in the terminal too."}`, confirm: "Delete", danger: true });
    if (ok) {
      await act(req("stored.delete", { file }), "Session deleted");
      void refreshStored();
    }
  }
  function open(r: Row) {
    if (r.live) setActive(r.live.id);
    else if (r.stored) void openSession(r.stored.cwd, r.stored.file);
  }

  function renderRows(key: string, rows: Row[], nested: boolean) {
    const shown = expanded[key] ? rows : rows.slice(0, PER_PROJECT);
    return (
      <>
        {shown.map((r) => {
          const active = !!r.live && r.live.id === activeId && page === "session";
          return (
            <div key={r.key} className={`sess ${nested ? "nested" : ""} ${active ? "active" : ""}`} onClick={() => open(r)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(r)}>
              <span className={`dot ${r.live ? r.live.status : "stopped"}`} />
              {(r.live?.harness ?? r.stored?.harness) === "claude" && (
                <span className="harness-tag" title="Runs on Claude Code (your Claude plan)">
                  CC
                </span>
              )}
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
        {rows.length > PER_PROJECT && (
          <button className={`side-more ${nested ? "nested" : ""}`} onClick={() => setExpanded({ ...expanded, [key]: !expanded[key] })}>
            {expanded[key] ? "Show less" : `Show ${rows.length - PER_PROJECT} more`}
          </button>
        )}
      </>
    );
  }

  function WorktreeHead({ sub, focused, onNew }: { sub: Sub; focused: boolean; onNew: () => void }) {
    const w = sub.wt;
    const label = w?.branch ?? (w?.detached ? `detached ${w.head.slice(0, 7)}` : baseName(sub.path));
    const bits: string[] = [];
    if (w?.dirty) bits.push(`${w.dirty} changed`);
    if (w?.upstream && w.ahead) bits.push(`${w.ahead}↑`);
    if (w?.upstream && w.behind) bits.push(`${w.behind}↓`);
    if (w && !w.upstream && w.unique) bits.push(`${w.unique} unpushed`);
    return (
      <div
        className={`wt-head ${focused ? "focused" : ""} ${w?.missing ? "missing" : ""}`}
        onClick={() => (w?.missing ? removeWorktreeDialog(sub.path) : switchProject(sub.path))}
        title={`${shortPath(sub.path, home)}${w?.main ? " (main checkout)" : ""}${bits.length ? " · " + bits.join(", ") : ""}`}
      >
        <GitBranch size={12} className="wt-icon" />
        <span className="ellipsis">{label}</span>
        {w?.main && w.branch !== "main" && w.branch !== "master" && <span className="wt-main">main</span>}
        {w?.missing && <span className="wt-main">missing</span>}
        {!!w?.dirty && <span className="wt-dirty" title={`${w.dirty} uncommitted change${w.dirty === 1 ? "" : "s"}`} />}
        <span className="project-actions">
          <button className="icon-btn" title={`New session in ${label}`} onClick={(e) => (e.stopPropagation(), onNew())}>
            <Plus size={12} />
          </button>
          {!w?.main && (
            <button className="icon-btn" title="Remove worktree…" onClick={(e) => (e.stopPropagation(), removeWorktreeDialog(sub.path))}>
              <Trash2 size={12} />
            </button>
          )}
        </span>
        {sub.rows.length > 0 && !focused && <span className="wt-n">{sub.rows.length}</span>}
      </div>
    );
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
        {repos.length === 0 && <div className="faint small" style={{ padding: "12px 10px" }}>Open a project folder to start.</div>}
        {repos.map((rg) => {
          const subs = [...rg.subs.values()].sort((a, b) => Number(!!b.wt?.main) - Number(!!a.wt?.main) || (a.wt?.branch ?? a.path).localeCompare(b.wt?.branch ?? b.path));
          const multi = !!rg.repo && rg.repo.worktrees.length > 1;
          const isCollapsed = collapsed[rg.key];
          const mainPath = rg.repo?.repo ?? rg.key;
          const focused = subs.some((x) => x.path === project);
          const allRows = subs.flatMap((x) => x.rows);
          return (
            <div
              className={`project ${drag?.key === rg.key ? "dragging" : ""} ${drag?.over === rg.key && drag.key !== rg.key ? (drag.after ? "drop-after" : "drop-before") : ""}`}
              key={rg.key}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const r = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > r.top + Math.min(r.height, 60) / 2;
                if (drag.over !== rg.key || drag.after !== after) setDrag({ ...drag, over: rg.key, after });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag?.over) moveProject(drag.key, drag.over, !!drag.after);
                setDrag(undefined);
              }}
            >
              <div
                className={`project-head ${focused ? "focused" : ""}`}
                draggable={!q.trim()}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", rg.key);
                  setDrag({ key: rg.key });
                }}
                onDragEnd={() => setDrag(undefined)}
                onClick={() => (focused ? setCollapsed({ ...collapsed, [rg.key]: !isCollapsed }) : switchProject(mainPath))}
                title={`${shortPath(mainPath, home)} — click to focus, drag to reorder`}
              >
                <span className="chev-btn" onClick={(e) => (e.stopPropagation(), setCollapsed({ ...collapsed, [rg.key]: !isCollapsed }))}>
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </span>
                <FolderOpen size={14} />
                <span className="ellipsis">{rg.repo?.name ?? baseName(rg.key)}</span>
                {multi && <span className="wt-count" title={`${rg.repo!.worktrees.length} worktrees`}>{rg.repo!.worktrees.length}</span>}
                <span className="project-actions">
                  {rg.repo && (
                    <button className="icon-btn" title="New worktree (new branch in its own folder)" onClick={(e) => (e.stopPropagation(), newWorktreeDialog(mainPath))}>
                      <GitBranchPlus size={13} />
                    </button>
                  )}
                  <button className="icon-btn" title="New session here" onClick={(e) => (e.stopPropagation(), void newSession(multi ? mainPath : (subs[0]?.path ?? mainPath)))}>
                    <Plus size={13} />
                  </button>
                  {allRows.length === 0 && !multi && (
                    <button className="icon-btn" title="Remove from list" onClick={(e) => (e.stopPropagation(), forgetProject(rg.key), useApp.setState({}))}>
                      <X size={13} />
                    </button>
                  )}
                </span>
              </div>
              {!isCollapsed &&
                (multi
                  ? subs.map((sub) => (
                      <div className="wt-group" key={sub.path}>
                        <WorktreeHead sub={sub} focused={sub.path === project} onNew={() => void newSession(sub.path)} />
                        {!collapsed[sub.path] && renderRows(sub.path, sub.rows, true)}
                      </div>
                    ))
                  : renderRows(rg.key, allRows, false))}
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
