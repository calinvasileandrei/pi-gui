import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, FileCode, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import type { ChangedFile } from "@pi-gui/protocol";
import { act, confirmDialog, insertIntoComposer, openViewer, req, useApp } from "../store.ts";
import { refreshGit, useProject, STATUS_LETTER } from "../project.ts";
import { setInternalDrag } from "../dnd.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import { baseName, timeAgo } from "./ui.tsx";

interface Commit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");

export function GitPanel() {
  const project = useApp((s) => s.project);
  const viewers = useApp((s) => s.viewers);
  const viewKey = useApp((s) => s.viewKey);
  const tab = useApp((s) => s.tab);
  const info = useProject((s) => (project ? s.git[project] : undefined));
  const error = useProject((s) => (project ? s.gitError[project] : undefined));
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Commit[]>();
  const [showLog, setShowLog] = useState(() => localStorage.getItem("pi-gui-git-log") === "1");
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>();

  const files = info?.files ?? [];
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  const unstaged = useMemo(() => files.filter((f) => f.unstaged || f.status === "untracked" || (!info?.git && !f.staged)), [files, info?.git]);

  useEffect(() => {
    if (!project || !showLog || !info?.git) return;
    void req<Commit[]>("git.log", { cwd: project }).then(setLog, () => setLog([]));
  }, [project, showLog, info?.git, info?.branch, info?.ahead, files.length]);

  if (!project) return <div className="gitpanel"><div className="gp-head"><GitBranch size={14} /> Source control</div><div className="explorer-empty faint small">No folder open</div></div>;

  const activeDiff = tab === "view" ? viewers.find((v) => v.key === viewKey && v.kind === "diff")?.path : undefined;
  const refresh = () => void refreshGit(project);
  const openDiff = (f: ChangedFile) => openViewer({ kind: "diff", root: info?.root ?? project, cwd: project, path: f.path, base: f.agent && !info?.git ? "agent" : "head" });

  async function stage(paths: string[], on: boolean) {
    await act(req("git.stage", { cwd: project, paths, stage: on }));
    refresh();
  }
  async function revert(f: ChangedFile) {
    const what = f.status === "untracked" || f.status === "added" ? "The new file moves to ~/.pi-gui/trash." : "It goes back to the last commit — your uncommitted edits to it are lost.";
    if (!(await confirmDialog({ title: `Discard changes to ${baseName(f.path)}?`, body: what, confirm: "Discard", danger: true }))) return;
    await act(req("git.revert", { cwd: project, path: f.path, base: info?.git ? "head" : "agent" }), "Changes discarded");
    refresh();
  }
  async function discardAll(list: ChangedFile[]) {
    if (!(await confirmDialog({ title: `Discard all ${list.length} changes?`, body: "Tracked files go back to the last commit; new files move to ~/.pi-gui/trash.", confirm: "Discard all", danger: true }))) return;
    for (const f of list) await act(req("git.revert", { cwd: project, path: f.path, base: "head" }));
    refresh();
  }
  async function commit() {
    if (!msg.trim()) return;
    const all = staged.length === 0;
    if (all && !(await confirmDialog({ title: "Commit all changes?", body: `Nothing is staged — this stages and commits all ${files.length} changed files.`, confirm: "Commit all" }))) return;
    setBusy(true);
    const r = await act(req<{ hash: string }>("git.commit", { cwd: project, message: msg, all }));
    setBusy(false);
    if (r) {
      setMsg("");
      useApp.getState().toast("success", `Committed ${r.hash}`);
      refresh();
      if (showLog) void req<Commit[]>("git.log", { cwd: project }).then(setLog, () => {});
    }
  }
  function fileMenu(e: React.MouseEvent, f: ChangedFile, inStaged: boolean) {
    e.preventDefault();
    const projRel = info && project!.startsWith(info.root + "/") ? f.path.slice(project!.length - info.root.length) : f.path;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open changes", icon: <GitCommitHorizontal size={14} />, run: () => openDiff(f) },
        { label: "Open file", icon: <FileCode size={14} />, disabled: f.status === "deleted", run: () => openViewer({ kind: "file", root: info?.root ?? project!, cwd: project!, path: f.path }) },
        { label: "Add to chat", icon: <Bot size={14} />, run: () => insertIntoComposer(`@${projRel} `) },
        { sep: true },
        ...(info?.git ? [inStaged ? { label: "Unstage", icon: <Minus size={14} />, run: () => void stage([f.path], false) } : { label: "Stage", icon: <Plus size={14} />, run: () => void stage([f.path], true) }] : []),
        { label: "Discard changes", icon: <Undo2 size={14} />, danger: true, run: () => void revert(f) },
      ],
    });
  }

  const section = (key: string, title: string, list: ChangedFile[], inStaged: boolean) => {
    if (!list.length) return null;
    const closed = fold[key];
    return (
      <div className="gp-section">
        <div className="gp-section-head" onClick={() => setFold({ ...fold, [key]: !closed })}>
          {closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span className="grow">{title}</span>
          <span className="gp-section-actions" onClick={(e) => e.stopPropagation()}>
            {info?.git && !inStaged && (
              <button className="icon-btn" title="Discard all" onClick={() => void discardAll(list)}>
                <Undo2 size={13} />
              </button>
            )}
            {info?.git && (
              <button className="icon-btn" title={inStaged ? "Unstage all" : "Stage all"} onClick={() => void stage(inStaged ? list.map((f) => f.path) : [], !inStaged)}>
                {inStaged ? <Minus size={13} /> : <Plus size={13} />}
              </button>
            )}
          </span>
          <span className="count">{list.length}</span>
        </div>
        {!closed &&
          list.map((f) => (
            <div
              key={key + f.path}
              className={`gp-file ${activeDiff === f.path ? "active" : ""}`}
              onClick={() => openDiff(f)}
              onContextMenu={(e) => fileMenu(e, f, inStaged)}
              draggable
              onDragStart={(e) => setInternalDrag(e.dataTransfer, { root: info?.root ?? project, paths: [f.path] })}
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            >
              <span className={`gp-name st-text ${f.status}`}>{baseName(f.path)}</span>
              <span className="gp-dir">{dirOf(f.path)}</span>
              <span className="gp-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="Discard changes" onClick={() => void revert(f)}>
                  <Undo2 size={12} />
                </button>
                {info?.git && (
                  <button className="icon-btn" title={inStaged ? "Unstage" : "Stage"} onClick={() => void stage([f.path], !inStaged)}>
                    {inStaged ? <Minus size={12} /> : <Plus size={12} />}
                  </button>
                )}
              </span>
              {f.agent && <Bot size={12} className="gp-bot" aria-label="changed by the agent" />}
              {(f.additions !== undefined || f.deletions !== undefined) && !inStaged && (
                <span className="nums">
                  {!!f.additions && <span className="a">+{f.additions}</span>}
                  {!!f.deletions && <span className="d">−{f.deletions}</span>}
                </span>
              )}
              <span className={`st ${f.status}`}>{STATUS_LETTER[f.status]}</span>
            </div>
          ))}
      </div>
    );
  };

  return (
    <div className="gitpanel">
      <div className="gp-head">
        <GitBranch size={14} />
        <span className="ellipsis grow" title={info?.root}>
          {info ? (info.git ? (info.branch ?? "HEAD") : "Not a git repository") : "Source control"}
        </span>
        {info?.git && (info.ahead || info.behind) ? (
          <span className="gp-sync" title={`${info.ahead ?? 0} to push, ${info.behind ?? 0} to pull`}>
            {!!info.behind && (
              <>
                <ArrowDown size={11} />
                {info.behind}
              </>
            )}
            {!!info.ahead && (
              <>
                <ArrowUp size={11} />
                {info.ahead}
              </>
            )}
          </span>
        ) : null}
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <RefreshCw size={13} />
        </button>
      </div>
      {info?.git && (
        <div className="gp-commit">
          <textarea
            className="input"
            rows={msg.includes("\n") ? 4 : 2}
            placeholder={`Message (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}⏎ to commit${staged.length ? "" : " all"})`}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void commit();
              }
            }}
          />
          <div className="row" style={{ gap: 6 }}>
            <button className="btn primary sm grow" disabled={!msg.trim() || busy || files.length === 0} onClick={() => void commit()}>
              {busy ? <span className="spinner" /> : <Check size={13} />} {staged.length ? `Commit ${staged.length} staged` : "Commit all"}
            </button>
            <button
              className="btn sm"
              title="Ask the agent to write the commit message"
              disabled={files.length === 0}
              onClick={() => insertIntoComposer("Write a concise conventional commit message for the current uncommitted changes (look at `git diff HEAD`). Reply with only the message.")}
            >
              <Bot size={13} />
            </button>
          </div>
        </div>
      )}
      <div className="gp-scroll">
        {error && <div className="banner err small" style={{ margin: 8, borderRadius: "var(--r-sm)" }}>{error}</div>}
        {!info && !error && (
          <div className="explorer-empty">
            <span className="spinner" />
          </div>
        )}
        {info && files.length === 0 && (
          <div className="gp-clean">
            <Check size={18} />
            <div>{info.git ? "Working tree clean" : "No changes from the agent yet"}</div>
            {!info.git && <div className="faint small">Files the agent edits here show up with a diff, even without git.</div>}
          </div>
        )}
        {section("staged", "Staged", staged, true)}
        {section("changes", info?.git ? "Changes" : "Changed by the agent", unstaged, false)}
        {info?.git && (
          <div className="gp-section">
            <div
              className="gp-section-head"
              onClick={() => {
                setShowLog(!showLog);
                localStorage.setItem("pi-gui-git-log", showLog ? "0" : "1");
              }}
            >
              {showLog ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="grow">Recent commits</span>
            </div>
            {showLog &&
              (log ?? []).map((c) => (
                <div key={c.hash} className="gp-commit-row" title={`${c.hash} · ${c.author}`}>
                  <GitCommitHorizontal size={13} className="faint" />
                  <span className="ellipsis grow">{c.subject}</span>
                  <span className="faint">{timeAgo(c.date)}</span>
                </div>
              ))}
            {showLog && log?.length === 0 && <div className="faint small" style={{ padding: "4px 14px 10px" }}>No commits yet</div>}
          </div>
        )}
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
    </div>
  );
}
