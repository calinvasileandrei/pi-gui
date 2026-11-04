import { useEffect, useState } from "react";
import { Blocks, FolderOpen, GitBranch, ShieldAlert } from "lucide-react";
import type { ExtensionInfo } from "@pi-gui/protocol";
import { act, confirmDialog, pickFolder, req, useApp } from "../store.ts";
import { Empty, Field, Modal, Toggle, baseName, shortPath } from "../components/ui.tsx";

interface Review {
  path: string;
  files: { path: string; size: number }[];
  main?: string;
  mainContent?: string;
  packageJson?: string;
}

async function restartAffected(ids: string[]) {
  if (!ids.length) return;
  const ok = await confirmDialog({ title: "Restart sessions to apply?", body: `${ids.length} open session${ids.length === 1 ? "" : "s"} must restart to load the change. Conversations are kept.`, confirm: "Restart now" });
  if (!ok) return;
  for (const id of ids) await act(req("session.restart", { id }));
  useApp.getState().toast("success", "Sessions restarted");
}

export function ExtensionsPage() {
  const { project, home } = useApp();
  const [list, setList] = useState<ExtensionInfo[]>();
  const [gitUrl, setGitUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review>();
  const [scope, setScope] = useState<"global" | "project">(project ? "project" : "global");

  const load = () => req<ExtensionInfo[]>("ext.list", { project }).then(setList, (e) => useApp.getState().toast("error", e.message));
  useEffect(() => void load(), [project]);

  async function toggle(e: ExtensionInfo, enabled: boolean) {
    const r = await act(req<{ affectedSessions: string[] }>("ext.toggle", { project, path: e.path, scope: e.scope, source: e.source, enabled }));
    await load();
    if (r) await restartAffected(r.affectedSessions);
  }
  async function reviewLocal() {
    const p = await pickFolder();
    if (!p) return;
    setBusy(true);
    const r = await act(req<Omit<Review, "path">>("ext.inspect", { path: p }));
    setBusy(false);
    if (r) setReview({ path: p, ...r });
  }
  async function reviewGit() {
    setBusy(true);
    const r = await act(req<Review>("ext.fetchGit", { url: gitUrl.trim() }));
    setBusy(false);
    if (r) setReview(r);
  }
  async function enableReviewed() {
    if (!review) return;
    const r = await act(req<{ affectedSessions: string[] }>("ext.add", { path: review.path, scope, project }), `Added ${baseName(review.path)}`);
    setReview(undefined);
    setGitUrl("");
    await load();
    if (r) await restartAffected(r.affectedSessions);
  }

  const groups: [string, ExtensionInfo[]][] = [
    ["Project", (list ?? []).filter((e) => e.scope === "project")],
    ["Global", (list ?? []).filter((e) => e.scope === "global")],
  ];

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h2>Extensions</h2>
            <p>Uses pi's own settings — anything you change here applies to pi in the terminal too.</p>
          </div>
        </div>
        <div className="banner warn" style={{ borderRadius: "var(--r)", border: "none", marginBottom: 16 }}>
          <ShieldAlert size={16} />
          <span>Extensions run with your full permissions. Only enable code you have reviewed or wrote yourself.</span>
        </div>
        {!list ? (
          <div className="empty-state"><span className="spinner" /></div>
        ) : (
          groups.map(([label, items]) =>
            items.length === 0 && label === "Project" && !project ? null : (
              <div className="card" key={label}>
                <div className="card-head">
                  <h3>{label}</h3>
                  <span className="faint small">{label === "Project" ? shortPath(project ?? "", home) + "/.pi" : "~/.pi/agent"}</span>
                </div>
                {items.length === 0 && <div className="card-body faint small">No extensions.</div>}
                {items.map((e) => (
                  <div className="list-item" key={e.path + e.scope}>
                    <span className="tool-icon">
                      <Blocks size={14} />
                    </span>
                    <div className="grow">
                      <div className="title">
                        {e.name}
                        {e.builtin && <span className="badge accent">built in</span>}
                        {!e.builtin && <span className="badge">{e.source === "auto" ? "auto-discovered" : e.source === "package" ? "package" : "settings"}</span>}
                      </div>
                      <div className="path">{shortPath(e.path, home)}</div>
                    </div>
                    <Toggle on={e.enabled} disabled={e.builtin || e.source === "package"} onChange={(v) => void toggle(e, v)} label={`Enable ${e.name}`} />
                  </div>
                ))}
              </div>
            ),
          )
        )}
        <div className="card">
          <div className="card-head">
            <h3>Add an extension</h3>
          </div>
          <div className="card-body form">
            <div className="row">
              <button className="btn" onClick={() => void reviewLocal()} disabled={busy}>
                <FolderOpen size={14} /> From a local folder…
              </button>
              <span className="faint small">or</span>
              <input className="input mono grow" placeholder="https://github.com/user/pi-extension.git" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} />
              <button className="btn" onClick={() => void reviewGit()} disabled={busy || !gitUrl.trim()}>
                {busy ? <span className="spinner" /> : <GitBranch size={14} />} Review
              </button>
            </div>
            <div className="hint faint small">Git sources are shallow-cloned into ~/.pi-gui/extension-src for review. Nothing runs until you enable it.</div>
          </div>
        </div>
      </div>
      {review && (
        <Modal wide onClose={() => setReview(undefined)}>
          <div className="modal-head">
            <div className="modal-icon warn">
              <ShieldAlert size={17} />
            </div>
            <div className="grow">
              <h3>Review {baseName(review.path)}</h3>
              <p className="mono small">{shortPath(review.path, home)}</p>
            </div>
          </div>
          <div className="modal-body col">
            <div className="faint small">
              {review.files.length} file{review.files.length === 1 ? "" : "s"}: {review.files.slice(0, 12).map((f) => f.path).join(", ")}
              {review.files.length > 12 ? "…" : ""}
            </div>
            {review.packageJson && (
              <>
                <div className="tool-section" style={{ padding: 0 }}>package.json</div>
                <pre className="source-view" style={{ maxHeight: 160 }}>{review.packageJson}</pre>
              </>
            )}
            <div className="tool-section" style={{ padding: 0 }}>{review.main ? baseName(review.main) : "No entry file found"}</div>
            {review.mainContent && <pre className="source-view">{review.mainContent}</pre>}
          </div>
          <div className="modal-foot">
            <Field label="">
              <select className="select" value={scope} onChange={(e) => setScope(e.target.value as "global" | "project")}>
                <option value="project" disabled={!project}>
                  This project only
                </option>
                <option value="global">All projects (global)</option>
              </select>
            </Field>
            <span className="grow" />
            <button className="btn" onClick={() => setReview(undefined)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!review.main} onClick={() => void enableReviewed()}>
              I've reviewed it — enable
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export { Empty };
