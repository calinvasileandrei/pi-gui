import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, GitBranch, GitBranchPlus, Trash2 } from "lucide-react";
import { create } from "zustand";
import type { WorktreeInfo } from "@pi-gui/protocol";
import { act, openSession, req, switchProject, useApp } from "../store.ts";
import { refreshWorktrees, useWorktrees, worktreeOf } from "../worktrees.ts";
import { Field, Modal, baseName, shortPath } from "./ui.tsx";

const useDialog = create<{ create?: { dir: string }; remove?: { path: string } }>(() => ({}));
export const newWorktreeDialog = (dir: string) => useDialog.setState({ create: { dir } });
export const removeWorktreeDialog = (path: string) => useDialog.setState({ remove: { path } });

export function WorktreeDialogHost() {
  const d = useDialog();
  return (
    <>
      {d.create && <CreateDialog dir={d.create.dir} onClose={() => useDialog.setState({ create: undefined })} />}
      {d.remove && <RemoveDialog path={d.remove.path} onClose={() => useDialog.setState({ remove: undefined })} />}
    </>
  );
}

interface Prep {
  repo: string;
  defaultBranch?: string;
  current?: string;
  branches: { local: string[]; remote: string[] };
  prefs: { setup?: string; copy?: string[]; dir?: string };
  taken: string[];
}

function CreateDialog({ dir, onClose }: { dir: string; onClose: () => void }) {
  const { home } = useApp();
  const [prep, setPrep] = useState<Prep>();
  const [err, setErr] = useState<string>();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [existing, setExisting] = useState("");
  const [path, setPath] = useState("");
  const pathEdited = useRef(false);
  const [copy, setCopy] = useState(".env*");
  const [setup, setSetup] = useState("");
  const [startSession, setStartSession] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showOptions, setShowOptions] = useState(false);

  useEffect(() => {
    req<Prep>("wt.prepare", { dir }).then(
      (p) => {
        setPrep(p);
        setBase(["main", "master"].find((b) => p.branches.local.includes(b)) ?? p.defaultBranch ?? p.current ?? "");
        setCopy((p.prefs.copy ?? [".env*"]).join(", "));
        setSetup(p.prefs.setup ?? "");
      },
      (e) => setErr((e as Error).message),
    );
  }, [dir]);

  const name = mode === "new" ? branch.trim() : existing;
  const free = useMemo(() => {
    if (!prep) return [];
    const taken = new Set(prep.taken);
    const local = prep.branches.local.filter((b) => !taken.has(b));
    const remote = prep.branches.remote.filter((r) => !taken.has(r.replace(/^[^/]+\//, "")) && !prep.branches.local.includes(r.replace(/^[^/]+\//, "")));
    return [...local, ...remote];
  }, [prep]);
  const clash = mode === "new" && !!name && (prep?.branches.local.includes(name) ?? false);

  useEffect(() => {
    if (!prep || pathEdited.current) return;
    const t = setTimeout(() => {
      const b = mode === "existing" ? name.replace(/^origin\//, "") : name;
      void req<string>("wt.suggestPath", { repo: prep.repo, branch: b || "new-branch" }).then(setPath, () => {});
    }, 120);
    return () => clearTimeout(t);
  }, [prep, name, mode]);

  async function submit() {
    if (!prep || !name || !path.trim()) return;
    setBusy(true);
    const r = await act(
      req<{ path: string; copied: string[]; terminalId?: string }>("wt.create", {
        repo: prep.repo,
        branch: name,
        base: mode === "new" ? base || undefined : undefined,
        existing: mode === "existing",
        path: path.trim(),
        copy: copy.split(",").map((s) => s.trim()).filter(Boolean),
        setup,
      }),
    );
    setBusy(false);
    if (!r) return;
    onClose();
    await refreshWorktrees(prep.repo);
    useApp.getState().toast("success", `Worktree ${baseName(r.path)} ready${r.copied.length ? ` · copied ${r.copied.join(", ")}` : ""}`);
    if (startSession) await openSession(r.path);
    else switchProject(r.path);
    if (r.terminalId) useApp.getState().setTerm({ open: true, activeId: r.terminalId });
  }

  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <div className="modal-icon">
          <GitBranchPlus size={17} />
        </div>
        <div className="grow">
          <h3>New worktree</h3>
          <p className="small faint">{prep ? baseName(prep.repo) : "…"}</p>
        </div>
      </div>
      <div className="modal-body form">
        {err && <div className="banner err small">{err}</div>}
        {mode === "new" ? (
          <Field label="Branch" error={clash ? "that branch already exists — check it out under Options" : undefined}>
            <input
              className="input mono"
              autoFocus
              value={branch}
              placeholder="feat/login-page"
              onChange={(e) => setBranch(e.target.value.replace(/\s+/g, "-"))}
              onKeyDown={(e) => e.key === "Enter" && !clash && void submit()}
            />
          </Field>
        ) : (
          <Field label="Branch to check out">
            <select className="select mono" value={existing} onChange={(e) => setExisting(e.target.value)} autoFocus>
              <option value="">Pick a branch…</option>
              {free.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="faint small wt-summary">
          {mode === "new" ? <>from <span className="mono">{base || "…"}</span> · </> : null}
          <span className="mono">…/{path.split("/").slice(-2).join("/") || "…"}</span>
          {setup.trim() ? <> · runs <span className="mono">{setup.trim()}</span></> : null}
        </div>
        <details className="wt-options" open={showOptions} onToggle={(e) => setShowOptions((e.target as HTMLDetailsElement).open)}>
          <summary>Options</summary>
          <div className="form" style={{ paddingTop: 10 }}>
            <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
              <div className="seg">
                <button className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>
                  New branch
                </button>
                <button className={mode === "existing" ? "on" : ""} onClick={() => setMode("existing")} disabled={!free.length}>
                  Existing branch
                </button>
              </div>
              {mode === "new" && (
                <Field label="From">
                  <select className="select" value={base} onChange={(e) => setBase(e.target.value)} style={{ maxWidth: 220 }}>
                    {prep?.branches.local.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                    {prep && prep.branches.remote.length > 0 && (
                      <optgroup label="Remote">
                        {prep.branches.remote.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </Field>
              )}
            </div>
            <Field label="Folder" hint={prep?.prefs.dir ? "Next to your previous worktrees." : "Change it once and new worktrees for this repo go there too."}>
              <input
                className="input mono"
                value={path}
                onChange={(e) => {
                  pathEdited.current = true;
                  setPath(e.target.value);
                }}
                title={shortPath(path, home)}
              />
            </Field>
            <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
              <div className="grow">
                <Field label="Copy from the main checkout" hint="Ignored files at the repo root, comma-separated.">
                  <input className="input mono" value={copy} onChange={(e) => setCopy(e.target.value)} placeholder=".env*, .npmrc" />
                </Field>
              </div>
              <div className="grow">
                <Field label="Setup command" hint="Runs in a terminal tab. Remembered per repo.">
                  <input className="input mono" value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="pnpm install" />
                </Field>
              </div>
            </div>
            <label className="row small" style={{ gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={startSession} onChange={(e) => setStartSession(e.target.checked)} /> Start a session in the new worktree
            </label>
          </div>
        </details>
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!prep || !name || clash || !path.trim() || busy} onClick={() => void submit()}>
          {busy ? <span className="spinner" /> : <GitBranchPlus size={14} />} Create worktree
        </button>
      </div>
    </Modal>
  );
}

function RemoveDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { home, sessions } = useApp();
  const byDir = useWorktrees((s) => s.byDir);
  const found = worktreeOf(path, byDir);
  const [fresh, setFresh] = useState<WorktreeInfo | undefined>(found?.wt);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void refreshWorktrees(path).then((r) => setFresh(r?.worktrees.find((w) => w.path === path)));
  }, [path]);
  const w = fresh ?? found?.wt;
  const repo = found?.repo;
  const live = sessions.filter((s) => !s.parentId && (s.cwd === path || s.cwd.startsWith(path + "/"))).length;
  const dirty = w?.dirty ?? 0;
  const unpushed = w?.upstream ? (w.ahead ?? 0) : (w?.unique ?? 0);
  const unmerged = !!w?.branch && w.merged === false;
  const risky = dirty > 0 || (deleteBranch && unmerged && unpushed > 0 && !w?.upstream);

  async function run() {
    setBusy(true);
    const r = await act(req<{ branchDeleted?: string }>("wt.remove", { path, force: risky || unmerged, deleteBranch: deleteBranch && !!w?.branch }));
    setBusy(false);
    if (!r) return;
    onClose();
    useApp.getState().toast("success", `Removed ${baseName(path)}${r.branchDeleted ? ` and branch ${r.branchDeleted}` : ""}`);
    const st = useApp.getState();
    if (repo && (st.project === path || st.project?.startsWith(path + "/"))) switchProject(repo.repo);
    if (repo) await refreshWorktrees(repo.repo);
  }

  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <div className={`modal-icon ${risky ? "danger" : "warn"}`}>
          <Trash2 size={17} />
        </div>
        <div className="grow">
          <h3>Remove worktree {w?.branch ?? baseName(path)}?</h3>
          <p className="mono small">{shortPath(path, home)}</p>
        </div>
      </div>
      <div className="modal-body col" style={{ gap: 10 }}>
        <div className="small">The folder is deleted. {w?.branch ? "Commits stay on the branch unless you delete it below." : ""}</div>
        {!w ? (
          <span className="spinner" />
        ) : (
          <ul className="wt-facts small">
            {w.missing && <li>The folder is already gone — this just cleans up git's record of it.</li>}
            {dirty > 0 && (
              <li className="err">
                <AlertTriangle size={13} /> {dirty} uncommitted change{dirty === 1 ? "" : "s"} will be lost
              </li>
            )}
            {w.branch && w.upstream && (w.ahead ?? 0) > 0 && (
              <li className="warn">
                <AlertTriangle size={13} /> {w.ahead} commit{w.ahead === 1 ? "" : "s"} not pushed
              </li>
            )}
            {w.branch && !w.upstream && (w.unique ?? 0) > 0 && (
              <li className="warn">
                <AlertTriangle size={13} /> {w.unique} commit{w.unique === 1 ? "" : "s"} only on this branch (never pushed)
              </li>
            )}
            {w.merged && <li className="ok">Branch is merged into {repo?.defaultBranch ?? "the default branch"}</li>}
            {!dirty && !(w.unique ?? 0) && !(w.ahead ?? 0) && !w.missing && <li className="ok">Nothing uncommitted or unpushed</li>}
            {live > 0 && (
              <li>
                {live} open session{live === 1 ? "" : "s"} here will be closed (history is kept)
              </li>
            )}
          </ul>
        )}
        {w?.branch && w.branch !== repo?.defaultBranch && (
          <label className="row small" style={{ gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> Also delete branch <span className="mono">{w.branch}</span>
            {unmerged && deleteBranch && <span className="badge warn">not merged</span>}
          </label>
        )}
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" disabled={!w || busy || w.main} onClick={() => void run()}>
          {busy ? <span className="spinner" /> : <Trash2 size={14} />} {risky ? "Remove anyway" : "Remove"}
        </button>
      </div>
    </Modal>
  );
}

export function BranchIcon({ size = 13 }: { size?: number }) {
  return <GitBranch size={size} />;
}
