import { useEffect, useState } from "react";
import { FileCode, FolderInput, GitCompareArrows, MessageSquarePlus, Minus, Plus, RotateCw, Save, Undo2, X } from "lucide-react";
import type { FileDiff } from "@pi-gui/protocol";
import { act, closeViewer, confirmDialog, insertIntoComposer, native, openViewer, req, useApp, type Viewer } from "../store.ts";
import { onFsChanged, refreshGit, refreshGitSoon, useProject } from "../project.ts";
import { CodeEditor, DiffEditor } from "./DiffEditor.tsx";
import { baseName } from "./ui.tsx";

interface Opened {
  path: string;
  text: string;
  language: string;
  binary: boolean;
  tooLarge: boolean;
  mtimeMs: number;
  size: number;
}

/** Strip of open files/diffs shown under the top bar. */
export function EditorTabs() {
  const viewers = useApp((s) => s.viewers);
  const viewKey = useApp((s) => s.viewKey);
  const tab = useApp((s) => s.tab);
  const dirty = useApp((s) => s.dirty);
  if (!viewers.length) return null;
  return (
    <div className="etabs">
      {viewers.map((v) => {
        const on = tab === "view" && v.key === viewKey;
        return (
          <div
            key={v.key}
            className={`etab ${on ? "on" : ""} ${dirty[v.key] ? "dirty" : ""}`}
            title={`${v.kind === "diff" ? "Changes: " : ""}${v.path}`}
            onClick={() => useApp.setState({ viewKey: v.key, tab: "view", page: "session" })}
            onAuxClick={(e) => e.button === 1 && void closeViewer(v.key)}
          >
            {v.kind === "diff" ? <GitCompareArrows size={13} className="etab-icon diff" /> : <FileCode size={13} className="etab-icon" />}
            <span className="ellipsis">{baseName(v.path)}</span>
            <button
              className="etab-x"
              title="Close (⌘W)"
              onClick={(e) => {
                e.stopPropagation();
                void closeViewer(v.key);
              }}
            >
              <X size={12} />
              <span className="etab-dot" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function EditorView({ v }: { v: Viewer }) {
  return v.kind === "file" ? <FileView v={v} key={v.key} /> : <DiffView v={v} key={v.key} />;
}

function FileView({ v }: { v: Viewer }) {
  const [file, setFile] = useState<Opened>();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string>();
  const [stale, setStale] = useState(false);
  const dirty = useApp((s) => !!s.dirty[v.key]);
  const setDirty = (d: boolean) => useApp.setState((s) => ({ dirty: { ...s.dirty, [v.key]: d } }));
  // git status of this file: tells us it's changed (diff button) and re-checks disk when the agent edits it
  const gitSig = useProject((s) => {
    const info = s.git[v.cwd];
    const f = info?.files.find((x) => `${info.root}/${x.path}` === `${v.root}/${v.path}`);
    return f ? `${f.status}:${f.additions}:${f.deletions}` : "";
  });
  const changed = !!gitSig;

  const load = async () => {
    try {
      const f = await req<Opened>("fs.read", { root: v.root, path: v.path });
      setFile(f);
      setText(f.text);
      setDirty(false);
      setStale(false);
      setErr(undefined);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => void load(), [v.root, v.path]);

  // the agent (or anything else) changed the file on disk
  useEffect(() => {
    if (!file) return;
    const check = async () => {
      const f = await req<Opened>("fs.read", { root: v.root, path: v.path }).catch(() => undefined);
      if (!f || Math.abs(f.mtimeMs - file.mtimeMs) < 1) return;
      if (useApp.getState().dirty[v.key]) setStale(true);
      else {
        setFile(f);
        setText(f.text);
      }
    };
    const dir = v.path.includes("/") ? v.path.slice(0, v.path.lastIndexOf("/")) : "";
    const off = onFsChanged((root, d) => root === v.root && d === dir && void check());
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [v.root, v.path, v.key, file]);
  useEffect(() => {
    if (!file || !gitSig) return;
    void req<Opened>("fs.read", { root: v.root, path: v.path }).then((f) => {
      if (Math.abs(f.mtimeMs - file.mtimeMs) < 1) return;
      if (useApp.getState().dirty[v.key]) setStale(true);
      else (setFile(f), setText(f.text));
    }, () => {});
  }, [gitSig]);

  async function save() {
    if (!file || !useApp.getState().dirty[v.key]) return;
    try {
      const r = await req<{ mtimeMs: number }>("fs.write", { root: v.root, path: v.path, text, mtimeMs: file.mtimeMs });
      setFile({ ...file, mtimeMs: r.mtimeMs, text });
      setDirty(false);
      setStale(false);
      refreshGitSoon(v.cwd, 100);
    } catch (e) {
      const m = (e as Error).message;
      if (/changed on disk/.test(m)) {
        setStale(true);
        if (await confirmDialog({ title: "File changed on disk", body: "Something else (maybe the agent) changed this file since you opened it. Overwrite it with your version?", confirm: "Overwrite", danger: true })) {
          const r = await act(req<{ mtimeMs: number }>("fs.write", { root: v.root, path: v.path, text }));
          if (r) {
            setFile({ ...file, mtimeMs: r.mtimeMs, text });
            setDirty(false);
            setStale(false);
          }
        }
      } else useApp.getState().toast("error", m);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const reveal = native().reveal;
  return (
    <div className="editor">
      <div className="diff-toolbar">
        <span className="mono ellipsis grow small">{v.path}</span>
        {stale && (
          <span className="badge warn" title="The file changed on disk while you were editing">
            changed on disk
          </span>
        )}
        {stale && (
          <button className="btn sm ghost" onClick={() => void load()}>
            <RotateCw size={13} /> Reload
          </button>
        )}
        {changed && (
          <button className="btn sm ghost" title="Show uncommitted changes" onClick={() => openViewer({ kind: "diff", root: useProject.getState().git[v.cwd]?.root ?? v.root, cwd: v.cwd, path: gitRel(v), base: "head" })}>
            <GitCompareArrows size={13} /> Changes
          </button>
        )}
        <button className="btn sm ghost" title="Mention this file in the chat" onClick={() => insertIntoComposer(`@${projRel(v)} `)}>
          <MessageSquarePlus size={13} /> Add to chat
        </button>
        {reveal && (
          <button className="icon-btn" title="Reveal in Finder" onClick={() => void reveal(`${v.root}/${v.path}`)}>
            <FolderInput size={14} />
          </button>
        )}
        <button className="btn sm primary" disabled={!dirty} onClick={() => void save()} title="Save (⌘S)">
          <Save size={13} /> Save
        </button>
      </div>
      <div className="diff-host">
        {err ? (
          <div className="diff-msg">{err}</div>
        ) : !file ? (
          <div className="diff-msg">
            <span className="spinner" />
          </div>
        ) : file.binary ? (
          <div className="diff-msg">Binary file · {(file.size / 1024).toFixed(1)} KB</div>
        ) : file.tooLarge ? (
          <div className="diff-msg">File is too large to open here ({(file.size / 1024 / 1024).toFixed(1)} MB)</div>
        ) : (
          <CodeEditor
            value={file.text}
            language={file.language}
            path={v.key}
            onChange={(t) => {
              setText(t);
              const d = t !== file.text;
              if (d !== useApp.getState().dirty[v.key]) setDirty(d);
            }}
            onSave={() => void save()}
          />
        )}
      </div>
    </div>
  );
}

/** viewer path relative to the git root (file viewers opened from the explorer are project-relative) */
function gitRel(v: Viewer): string {
  const info = useProject.getState().git[v.cwd];
  if (!info || v.root === info.root) return v.path;
  return v.root.startsWith(info.root + "/") ? `${v.root.slice(info.root.length + 1)}/${v.path}` : v.path;
}
function projRel(v: Viewer): string {
  if (v.root === v.cwd) return v.path;
  const abs = `${v.root}/${v.path}`;
  return abs.startsWith(v.cwd + "/") ? abs.slice(v.cwd.length + 1) : abs;
}

function DiffView({ v }: { v: Viewer }) {
  const info = useProject((s) => s.git[v.cwd]);
  const f = info?.files.find((x) => x.path === v.path);
  const [base, setBase] = useState<"head" | "agent">(v.base ?? "head");
  const [diff, setDiff] = useState<FileDiff>();
  const [loading, setLoading] = useState(false);
  const sig = f ? `${f.status}:${f.additions}:${f.deletions}:${f.staged}:${f.unstaged}` : "gone";

  useEffect(() => {
    let alive = true;
    setLoading(true);
    req<FileDiff>("git.diff", { cwd: v.cwd, path: v.path, base })
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && useApp.getState().toast("error", e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [v.cwd, v.path, base, sig]);

  async function revert() {
    if (!f) return;
    const target = base === "agent" && f.agent ? "the version from before the agent touched it" : f.status === "untracked" || f.status === "added" ? "nothing — the new file moves to ~/.pi-gui/trash" : "the last commit";
    if (!(await confirmDialog({ title: `Revert ${baseName(f.path)}?`, body: `This restores ${target}.`, confirm: "Revert", danger: true }))) return;
    await act(req("git.revert", { cwd: v.cwd, path: f.path, base: base === "agent" && f.agent ? "agent" : "head" }), "Reverted");
    void refreshGit(v.cwd);
  }

  return (
    <div className="editor">
      <div className="diff-toolbar">
        <span className="mono ellipsis grow small">{v.path}</span>
        {f?.agent && (
          <div className="seg">
            <button className={base === "head" ? "on" : ""} onClick={() => setBase("head")} disabled={!info?.git}>
              vs HEAD
            </button>
            <button className={base === "agent" ? "on" : ""} onClick={() => setBase("agent")}>
              vs before agent
            </button>
          </div>
        )}
        {loading && <span className="spinner" />}
        {!f && info && <span className="badge">no longer changed</span>}
        {f && f.status !== "deleted" && (
          <button className="btn sm ghost" onClick={() => openViewer({ kind: "file", root: info?.root ?? v.root, cwd: v.cwd, path: v.path })}>
            <FileCode size={13} /> Open file
          </button>
        )}
        {f && info?.git && (
          <button className="btn sm ghost" onClick={() => void act(req("git.stage", { cwd: v.cwd, paths: [f.path], stage: !f.staged || !!f.unstaged })).then(() => refreshGit(v.cwd))}>
            {f.staged && !f.unstaged ? <Minus size={13} /> : <Plus size={13} />} {f.staged && !f.unstaged ? "Unstage" : "Stage"}
          </button>
        )}
        {f && (
          <button className="btn sm danger" onClick={() => void revert()}>
            <Undo2 size={13} /> Revert
          </button>
        )}
      </div>
      <div className="diff-host">
        {diff?.binary ? (
          <div className="diff-msg">Binary file — no preview</div>
        ) : diff?.tooLarge ? (
          <div className="diff-msg">File is too large to diff here (&gt; 2 MB)</div>
        ) : diff ? (
          <DiffEditor original={diff.original} modified={diff.modified} language={diff.language} path={diff.path} />
        ) : (
          <div className="diff-msg">
            <span className="spinner" />
          </div>
        )}
      </div>
    </div>
  );
}
