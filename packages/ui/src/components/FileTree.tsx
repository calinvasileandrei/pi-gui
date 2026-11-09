import { useWorktrees, worktreeOf } from "../worktrees.ts";
import { newWorktreeDialog } from "./WorktreeDialogs.tsx";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, ChevronsDownUp, Copy, File, FileCode, FileImage, FileJson, FileLock, FilePlus, FileText, Folder, FolderInput,
  FolderOpen, FolderPlus, MessageSquarePlus, Pencil, RefreshCw, Search, Trash2, X,
  GitBranch,
  GitBranchPlus,
} from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import type { FsEntry } from "@pi-gui/protocol";
import { act, closeViewer, confirmDialog, insertIntoComposer, native, openViewer, pickFolder, promptDialog, recentProjects, renameViewerPaths, req, switchProject, useApp } from "../store.ts";
import { decorations, onFsChanged, refreshGitSoon, useProject, STATUS_LETTER } from "../project.ts";
import { droppedFiles, fileToBase64, hasFiles, hasInternal, readInternal, setInternalDrag } from "../dnd.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import { baseName, shortPath } from "./ui.tsx";

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

const loadExpanded = (root: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(`pi-gui-tree:${root}`) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};
const saveExpanded = (root: string, s: Set<string>) => {
  try {
    localStorage.setItem(`pi-gui-tree:${root}`, JSON.stringify([...s].slice(0, 300)));
  } catch {
    /* ignore */
  }
};

function iconFor(e: FsEntry, open: boolean) {
  if (e.dir) return open ? <FolderOpen size={15} className="fi-folder" /> : <Folder size={15} className="fi-folder" />;
  const n = e.name.toLowerCase();
  if (/(^|\.)(lock|lockb)$|-lock\.(json|yaml)$/.test(n)) return <FileLock size={15} className="fi-muted" />;
  if (/\.(json|jsonc|json5)$/.test(n)) return <FileJson size={15} className="fi-json" />;
  if (/\.(png|jpe?g|gif|webp|svg|ico|icns|bmp|avif)$/.test(n)) return <FileImage size={15} className="fi-image" />;
  if (/\.(md|mdx|txt|rst|log)$/.test(n) || n === "license" || n === "readme") return <FileText size={15} className="fi-text" />;
  if (/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/.test(n)) return <FileCode size={15} className="fi-ts" />;
  if (/\.(py|rb|go|rs|java|kt|swift|m|mm|c|h|cpp|hpp|cs|php|sh|zsh|bash|css|scss|less|html|vue|svelte|sql|graphql|ya?ml|toml|xml|gradle)$/.test(n)) return <FileCode size={15} className="fi-code" />;
  return <File size={15} className="fi-muted" />;
}

interface Row {
  e: FsEntry;
  depth: number;
  open: boolean;
  loading: boolean;
}

export function FileTree() {
  const project = useApp((s) => s.project);
  const home = useApp((s) => s.home);
  const viewers = useApp((s) => s.viewers);
  const viewKey = useApp((s) => s.viewKey);
  const tab = useApp((s) => s.tab);
  const gitInfo = useProject((s) => (project ? s.git[project] : undefined));
  const [children, setChildren] = useState<Record<string, FsEntry[] | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string>();
  const [dropDir, setDropDir] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>();
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const listRef = useRef<HTMLDivElement>(null);

  const deco = useMemo(() => (project ? decorations(project, gitInfo) : { files: new Map(), dirs: new Set<string>() }), [project, gitInfo]);

  const load = useCallback(
    async (dir: string) => {
      if (!project) return;
      try {
        const list = await req<FsEntry[]>("fs.list", { root: project, dir });
        setChildren((c) => ({ ...c, [dir]: list }));
        setErrors((x) => {
          const n = { ...x };
          delete n[dir];
          return n;
        });
      } catch (e) {
        setChildren((c) => ({ ...c, [dir]: [] }));
        setErrors((x) => ({ ...x, [dir]: (e as Error).message }));
        // a folder that vanished: forget it
        if (dir) setExpanded((s) => (s.has(dir) ? new Set([...s].filter((d) => d !== dir && !d.startsWith(dir + "/"))) : s));
      }
    },
    [project],
  );

  // project switched: reset and load the remembered expansion
  useEffect(() => {
    setChildren({});
    setErrors({});
    setSel(undefined);
    setFilter("");
    if (!project) return;
    const ex = loadExpanded(project);
    setExpanded(ex);
    void load("");
    for (const d of ex) void load(d);
    return () => void req("fs.watch", { root: project, dirs: [] }).catch(() => {});
  }, [project, load]);

  // watch exactly what's visible
  useEffect(() => {
    if (!project) return;
    saveExpanded(project, expanded);
    const t = setTimeout(() => void req("fs.watch", { root: project, dirs: ["", ...expanded] }).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [project, expanded]);

  useEffect(
    () =>
      onFsChanged((root, dir) => {
        if (root !== project) return;
        if (childrenRef.current[dir] !== undefined) void load(dir);
      }),
    [project, load],
  );

  const toggle = (dir: string, open?: boolean) =>
    setExpanded((s) => {
      const n = new Set(s);
      const want = open ?? !n.has(dir);
      if (want) {
        n.add(dir);
        if (childrenRef.current[dir] === undefined) void load(dir);
      } else n.delete(dir);
      return n;
    });

  const rows = useMemo(() => {
    const out: Row[] = [];
    const needle = filter.trim().toLowerCase();
    const walk = (dir: string, depth: number) => {
      for (const e of children[dir] ?? []) {
        const open = e.dir && expanded.has(e.path);
        if (!needle || e.dir || e.name.toLowerCase().includes(needle)) out.push({ e, depth, open, loading: open && children[e.path] === undefined });
        if (open) walk(e.path, depth + 1);
      }
    };
    walk("", 0);
    if (!needle) return out;
    // keep folders only when something below them matched
    const keep = new Set<number>();
    for (let i = out.length - 1, minDepth = Infinity; i >= 0; i--) {
      const r = out[i]!;
      if (!r.e.dir) {
        keep.add(i);
        minDepth = Math.min(minDepth, r.depth);
      } else if (r.depth < minDepth || r.e.name.toLowerCase().includes(needle)) {
        if (r.depth < minDepth) minDepth = r.depth;
        keep.add(i);
      }
    }
    return out.filter((_, i) => keep.has(i));
  }, [children, expanded, filter]);

  const activeFile = tab === "view" ? viewers.find((v) => v.key === viewKey && v.kind === "file" && v.root === project)?.path : undefined;

  if (!project)
    return (
      <div className="explorer">
        <ExplorerHead />
        <div className="explorer-empty">
          <p>No folder open</p>
          <button className="btn sm primary" onClick={() => void pickFolder().then((d) => d && switchProject(d))}>
            <FolderInput size={13} /> Open folder…
          </button>
        </div>
      </div>
    );

  // ---- actions ----
  const abs = (rel: string) => (rel ? `${project}/${rel}` : project);
  const open = (e: FsEntry) => (e.dir ? toggle(e.path) : openViewer({ kind: "file", root: project, cwd: project, path: e.path }));
  const reloadDirs = (...dirs: string[]) => new Set(dirs).forEach((d) => void load(d));

  async function create(dir: string, isDir: boolean) {
    const name = await promptDialog({ title: isDir ? "New folder" : "New file", body: `In ${dir || baseName(project!)}`, placeholder: isDir ? "folder-name" : "file.ts (use / for subfolders)", confirm: "Create" });
    if (!name?.trim()) return;
    const p = await act(req<string>("fs.create", { root: project, path: join(dir, name.trim()), dir: isDir }));
    if (!p) return;
    if (dir) toggle(dir, true);
    reloadDirs(dir, parentOf(p));
    setSel(p);
    if (!isDir) openViewer({ kind: "file", root: project!, cwd: project!, path: p });
  }
  async function rename(e: FsEntry) {
    const name = await promptDialog({ title: `Rename ${e.dir ? "folder" : "file"}`, value: e.name, confirm: "Rename" });
    if (!name?.trim() || name === e.name) return;
    const p = await act(req<string>("fs.rename", { root: project, path: e.path, name: name.trim() }));
    if (p) {
      reloadDirs(parentOf(e.path));
      setSel(p);
      renameViewerPaths(project!, e.path, p);
    }
  }
  async function trash(e: FsEntry) {
    const ok = await confirmDialog({ title: `Delete ${e.name}?`, body: `It moves to ~/.pi-gui/trash — nothing is permanently deleted.`, confirm: "Move to trash", danger: true });
    if (!ok) return;
    if (await act(req("fs.trash", { root: project, paths: [e.path] }), `Moved ${e.name} to trash`)) {
      reloadDirs(parentOf(e.path));
      for (const v of useApp.getState().viewers) if (v.root === project && (v.path === e.path || v.path.startsWith(e.path + "/"))) void closeViewer(v.key);
    }
  }
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => useApp.getState().toast("success", "Copied"));

  function entryMenu(ev: React.MouseEvent, e?: FsEntry) {
    ev.preventDefault();
    ev.stopPropagation();
    if (e) setSel(e.path);
    const dir = e ? (e.dir ? e.path : parentOf(e.path)) : "";
    const reveal = native().reveal;
    const items: MenuItem[] = [
      { label: "New file…", icon: <FilePlus size={14} />, run: () => void create(dir, false) },
      { label: "New folder…", icon: <FolderPlus size={14} />, run: () => void create(dir, true) },
    ];
    if (e) {
      items.push(
        { sep: true },
        { label: "Add to chat", icon: <MessageSquarePlus size={14} />, run: () => insertIntoComposer(`@${e.path} `) },
        { label: "Rename…", icon: <Pencil size={14} />, hint: "↩", run: () => void rename(e) },
        { label: "Copy path", icon: <Copy size={14} />, run: () => copy(abs(e.path)) },
        { label: "Copy relative path", icon: <Copy size={14} />, run: () => copy(e.path) },
      );
      if (reveal) items.push({ label: "Reveal in Finder", icon: <FolderInput size={14} />, run: () => void reveal(abs(e.path)) });
      items.push({ sep: true }, { label: "Move to trash", icon: <Trash2 size={14} />, hint: "⌘⌫", danger: true, run: () => void trash(e) });
    } else if (reveal) items.push({ sep: true }, { label: "Reveal in Finder", icon: <FolderInput size={14} />, run: () => void reveal(project!) });
    setMenu({ x: ev.clientX, y: ev.clientY, items });
  }

  // ---- drag & drop ----
  const targetFor = (e?: FsEntry) => (e ? (e.dir ? e.path : parentOf(e.path)) : "");
  function onDragOver(ev: React.DragEvent, e?: FsEntry) {
    if (!hasInternal(ev.dataTransfer) && !hasFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = hasInternal(ev.dataTransfer) && !ev.altKey ? "move" : "copy";
    const t = targetFor(e);
    if (t !== dropDir) {
      setDropDir(t);
      clearTimeout(hoverTimer.current);
      // hovering a closed folder opens it, like Finder
      if (e?.dir && !expanded.has(e.path)) hoverTimer.current = setTimeout(() => toggle(e.path, true), 650);
    }
  }
  async function onDrop(ev: React.DragEvent, e?: FsEntry) {
    ev.preventDefault();
    ev.stopPropagation();
    clearTimeout(hoverTimer.current);
    setDropDir(undefined);
    const to = targetFor(e);
    const internal = hasInternal(ev.dataTransfer) ? readInternal(ev.dataTransfer) : undefined;
    if (internal) {
      if (internal.root !== project) {
        // dragged from another project's tree (rare): copy
        const r = await act(req<string[]>("fs.copyIn", { root: project, sources: internal.paths.map((p) => `${internal.root}/${p}`), to }));
        if (r?.length) reloadDirs(to);
        return;
      }
      const from = internal.paths.filter((p) => parentOf(p) !== to && p !== to);
      if (!from.length) return;
      const copyMode = ev.altKey;
      const r = copyMode
        ? await act(req<string[]>("fs.copyIn", { root: project, sources: from.map(abs), to }), `Copied ${from.length === 1 ? baseName(from[0]!) : `${from.length} items`}`)
        : await act(req<string[]>("fs.move", { root: project, from, to }), `Moved ${from.length === 1 ? baseName(from[0]!) : `${from.length} items`} to ${to || baseName(project!)}`);
      if (r) {
        if (to) toggle(to, true);
        reloadDirs(to, ...from.map(parentOf));
        if (r[0]) setSel(r[0]);
        refreshGitSoon(project!);
        if (!copyMode) from.forEach((p, i) => r[i] && renameViewerPaths(project!, p, r[i]!));
      }
      return;
    }
    if (hasFiles(ev.dataTransfer)) {
      const { files, paths } = droppedFiles(ev.dataTransfer);
      let r: string[] | undefined;
      if (paths.length === files.length && paths.length) r = await act(req<string[]>("fs.copyIn", { root: project, sources: paths, to }));
      else {
        r = [];
        for (const f of files) {
          if (f.size > 30 * 1024 * 1024) {
            useApp.getState().toast("error", `${f.name} is too large to upload from the browser`);
            continue;
          }
          const p = await act(req<string>("fs.upload", { root: project, to, name: f.name, data: await fileToBase64(f) }));
          if (p) r.push(p);
        }
      }
      if (r?.length) {
        useApp.getState().toast("success", `Copied ${r.length === 1 ? baseName(r[0]!) : `${r.length} items`} into ${to || baseName(project!)}`);
        if (to) toggle(to, true);
        reloadDirs(to);
        setSel(r[0]);
      }
    }
  }

  // ---- keyboard ----
  function onKey(ev: React.KeyboardEvent) {
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    const i = rows.findIndex((r) => r.e.path === sel);
    const cur = rows[i];
    const go = (j: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (r) setSel(r.e.path);
    };
    if (ev.key === "ArrowDown") go(i + 1);
    else if (ev.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else if (ev.key === "ArrowRight" && cur?.e.dir) cur.open ? go(i + 1) : toggle(cur.e.path, true);
    else if (ev.key === "ArrowLeft" && cur) cur.open ? toggle(cur.e.path, false) : go(rows.findIndex((r) => r.e.path === parentOf(cur.e.path)));
    else if (ev.key === "Enter" && cur) cur.e.dir ? toggle(cur.e.path) : void rename(cur.e);
    else if (ev.key === " " && cur) open(cur.e);
    else if (ev.key === "Backspace" && ev.metaKey && cur) void trash(cur.e);
    else return;
    ev.preventDefault();
  }

  const rootErr = errors[""];
  return (
    <div className="explorer">
      <ExplorerHead
        actions={
          <>
            <button className="icon-btn" title="Filter files" onClick={() => setShowFilter((v) => !v)}>
              <Search size={14} />
            </button>
            <button className="icon-btn" title="New file" onClick={() => void create(sel ? targetFor(rows.find((r) => r.e.path === sel)?.e) : "", false)}>
              <FilePlus size={14} />
            </button>
            <button className="icon-btn" title="New folder" onClick={() => void create(sel ? targetFor(rows.find((r) => r.e.path === sel)?.e) : "", true)}>
              <FolderPlus size={14} />
            </button>
            <button className="icon-btn" title="Refresh" onClick={() => reloadDirs("", ...expanded)}>
              <RefreshCw size={13} />
            </button>
            <button className="icon-btn" title="Collapse all" onClick={() => setExpanded(new Set())}>
              <ChevronsDownUp size={14} />
            </button>
          </>
        }
      />
      {showFilter && (
        <div className="explorer-filter">
          <Search size={13} />
          <input autoFocus className="input" placeholder="Filter open folders" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (setFilter(""), setShowFilter(false))} />
          {filter && (
            <button className="icon-btn" onClick={() => setFilter("")}>
              <X size={12} />
            </button>
          )}
        </div>
      )}
      <div
        ref={listRef}
        className={`tree ${dropDir === "" ? "drop-root" : ""}`}
        tabIndex={0}
        onKeyDown={onKey}
        onContextMenu={(e) => entryMenu(e)}
        onDragOver={(e) => onDragOver(e)}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropDir(undefined)}
        onDrop={(e) => void onDrop(e)}
      >
        {rootErr ? (
          <div className="explorer-empty">
            <p className="small">{rootErr}</p>
          </div>
        ) : children[""] === undefined ? (
          <div className="explorer-empty">
            <span className="spinner" />
          </div>
        ) : rows.length === 0 ? (
          <div className="explorer-empty faint small">{filter ? "No matches in open folders" : "Empty folder — drop files here"}</div>
        ) : (
          <Virtuoso
            style={{ height: "100%" }}
            data={rows}
            computeItemKey={(_, r) => r.e.path}
            increaseViewportBy={200}
            itemContent={(_, r) => (
              <TreeRow
                r={r}
                selected={sel === r.e.path}
                active={activeFile === r.e.path}
                drop={dropDir !== undefined && dropDir !== "" && (r.e.path === dropDir || r.e.path.startsWith(dropDir + "/"))}
                dropHead={r.e.path === dropDir}
                status={r.e.dir ? (deco.dirs.has(r.e.path) ? "dir" : undefined) : deco.files.get(r.e.path)?.status}
                onClick={(ev) => {
                  setSel(r.e.path);
                  listRef.current?.focus({ preventScroll: true });
                  if (ev.detail > 1) return;
                  open(r.e);
                }}
                onContext={(ev) => entryMenu(ev, r.e)}
                onDragStart={(ev) => {
                  setSel(r.e.path);
                  setInternalDrag(ev.dataTransfer, { root: project, paths: [r.e.path] });
                }}
                onDragOver={(ev) => onDragOver(ev, r.e)}
                onDrop={(ev) => void onDrop(ev, r.e)}
              />
            )}
          />
        )}
      </div>
      <div className="explorer-foot faint" title={project}>
        {shortPath(project, home)}
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
    </div>
  );
}

const TreeRow = memo(function TreeRow(p: {
  r: Row;
  selected: boolean;
  active: boolean;
  drop: boolean;
  dropHead: boolean;
  status?: string;
  onClick: (e: React.MouseEvent) => void;
  onContext: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { e, depth, open, loading } = p.r;
  const st = p.status && p.status !== "dir" ? p.status : undefined;
  return (
    <div
      className={`tree-row ${p.selected ? "sel" : ""} ${p.active ? "active" : ""} ${p.drop ? "drop" : ""} ${p.dropHead ? "drop-head" : ""} ${e.ignored ? "ignored" : ""} ${st ? `g-${st}` : ""} ${p.status === "dir" ? "g-dir" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      draggable
      onClick={p.onClick}
      onContextMenu={p.onContext}
      onDragStart={p.onDragStart}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
      title={e.path}
    >
      <span className="tree-chev">{e.dir ? loading ? <span className="spinner xs" /> : open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</span>
      {iconFor(e, open)}
      <span className="tree-name">{e.name}</span>
      {st && <span className={`tree-st`}>{STATUS_LETTER[st as keyof typeof STATUS_LETTER]}</span>}
      {p.status === "dir" && <span className="tree-dot" />}
    </div>
  );
});

/** Header with the project switcher (recent folders + open…). */
function ExplorerHead({ actions }: { actions?: React.ReactNode }) {
  const project = useApp((s) => s.project);
  const home = useApp((s) => s.home);
  const sessions = useApp((s) => s.sessions);
  const byDir = useWorktrees((s) => s.byDir);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const here = worktreeOf(project, byDir);
  const wts = here && here.repo.worktrees.length > 1 ? here.repo.worktrees : [];
  const inRepo = new Set(here?.repo.worktrees.map((w) => w.path) ?? []);
  const projects = [...new Set([...(project ? [project] : []), ...sessions.filter((s) => !s.parentId).map((s) => s.cwd), ...recentProjects()])]
    .filter((p) => !inRepo.has(p) && !(here && worktreeOf(p, byDir)?.repo.repo === here.repo.repo))
    .slice(0, 12);
  const open = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4 });
  };
  return (
    <div className="explorer-head">
      <button className="proj-switch" title={project ? shortPath(project, home) : "Switch project"} onClick={open}>
        <span className="ellipsis">{here ? here.repo.name : project ? baseName(project) : "No folder"}</span>
        {here?.wt.branch && (
          <span className="proj-branch">
            <GitBranch size={11} />
            <span className="ellipsis">{here.wt.branch}</span>
          </span>
        )}
        <ChevronDown size={13} />
      </button>
      <span className="grow" />
      <span className="explorer-actions">{actions}</span>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          items={[
            ...wts.map<MenuItem>((w) => ({
              label: w.branch ?? baseName(w.path),
              hint: w.main ? "main checkout" : w.missing ? "missing" : w.dirty ? `${w.dirty} changed` : undefined,
              icon: <GitBranch size={14} />,
              checked: w.path === here?.wt.path,
              disabled: w.missing,
              run: () => switchProject(w.path),
            })),
            ...(here ? [{ label: "New worktree…", icon: <GitBranchPlus size={14} />, run: () => newWorktreeDialog(project!) } as MenuItem, { sep: true } as MenuItem] : []),
            ...projects.map<MenuItem>((p) => ({ label: baseName(p), hint: shortPath(p, home).replace(/\/[^/]+$/, ""), icon: <Folder size={14} />, checked: p === project, run: () => switchProject(p) })),
            ...(projects.length ? [{ sep: true } as MenuItem] : []),
            { label: "Open folder…", icon: <FolderInput size={14} />, hint: "⌘O", run: () => void pickFolder().then((d) => d && switchProject(d)) },
          ]}
        />
      )}
    </div>
  );
}
