import { useEffect, useState } from "react";
import { FolderOpen, Play, Plus, SquareTerminal, Trash2, X } from "lucide-react";
import type { TerminalProfileInfo } from "@pi-gui/protocol";
import { act, confirmDialog, loadProfiles, pickFolder, req, useApp } from "../store.ts";
import { Empty, Field, Toggle, baseName, shortPath } from "../components/ui.tsx";
import { startProfile } from "../components/TerminalPanel.tsx";

interface Draft {
  name: string;
  cwd: string;
  command: string;
  env: [string, string][];
  port: string;
  autostart: boolean;
  restartOnExit: boolean;
  scope: "project" | "global";
  previousName?: string;
}
const blank = (): Draft => ({ name: "", cwd: ".", command: "", env: [], port: "", autostart: false, restartOnExit: false, scope: "project" });
const fromProfile = (p: TerminalProfileInfo): Draft => ({
  name: p.name,
  cwd: p.cwd,
  command: p.command,
  env: Object.entries(p.env),
  port: p.port ? String(p.port) : "",
  autostart: p.autostart,
  restartOnExit: p.restartOnExit,
  scope: p.scope,
  previousName: p.name,
});

export function TerminalsPage() {
  const { project, profiles, home, setTerm, terminals } = useApp();
  const data = project ? profiles[project] : undefined;
  const [draft, setDraft] = useState<Draft>();
  const [cwdCheck, setCwdCheck] = useState<{ resolved: string; error?: string }>();

  useEffect(() => {
    if (project) void loadProfiles(project);
  }, [project]);
  useEffect(() => {
    if (!draft || !project) return;
    const t = setTimeout(() => void req<typeof cwdCheck>("terminal.checkDir", { project, cwd: draft.cwd || "." }).then(setCwdCheck, () => {}), 200);
    return () => clearTimeout(t);
  }, [draft?.cwd, project]);

  if (!project)
    return (
      <div className="page">
        <Empty icon={<SquareTerminal size={22} />} title="Open a project first">
          <p>Terminal profiles are saved per project in .pi/terminals.json (or globally).</p>
        </Empty>
      </div>
    );

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const portErr = draft?.port && !/^\d{1,5}$/.test(draft.port) ? "1–65535" : undefined;
  const nameClash = draft && data?.profiles.some((p) => p.name.toLowerCase() === draft.name.toLowerCase() && p.name !== draft.previousName && p.scope === draft.scope);

  async function save() {
    if (!draft) return;
    const profile = {
      name: draft.name.trim(),
      cwd: draft.cwd.trim() || ".",
      command: draft.command.trim(),
      env: Object.fromEntries(draft.env.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
      ...(draft.port ? { port: Number(draft.port) } : {}),
      autostart: draft.autostart,
      restartOnExit: draft.restartOnExit,
    };
    const r = await act(req("terminal.saveProfile", { project, scope: draft.scope, profile, previousName: draft.previousName }), `Saved ${profile.name}`);
    if (r) {
      await loadProfiles(project!);
      setDraft(undefined);
    }
  }
  async function remove(p: TerminalProfileInfo) {
    if (!(await confirmDialog({ title: `Delete “${p.name}”?`, confirm: "Delete", danger: true }))) return;
    if (await act(req("terminal.deleteProfile", { project, scope: p.scope, name: p.name }))) {
      await loadProfiles(project!);
      setDraft(undefined);
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h2>Terminal profiles</h2>
            <p>
              Saved commands for <strong>{baseName(project)}</strong> — Metro, dev servers, watchers. Run through your login shell, so nvm and Homebrew work. Stored in <code>.pi/terminals.json</code> or <code>~/.pi/agent/terminals.json</code>.
            </p>
          </div>
          <button className="btn primary" onClick={() => setDraft(blank())}>
            <Plus size={14} /> New profile
          </button>
        </div>
        {data?.errors.length ? (
          <div className="config-errors">
            {data.errors.map((e, i) => (
              <div key={i}>
                <span className="file">{e.file}</span> — {e.message}
              </div>
            ))}
          </div>
        ) : null}
        <div className="split">
          <div className="card">
            {!data?.profiles.length && <div className="card-body faint small">No profiles yet. Try “Metro” with <code>npx react-native start</code> on port 8081.</div>}
            {data?.profiles.map((p) => {
              const live = terminals.find((t) => t.id === p.id);
              return (
                <div key={p.id} className={`list-item clickable ${draft?.previousName === p.name ? "selected" : ""}`} onClick={() => setDraft(fromProfile(p))}>
                  <span className={`dot ${live?.status ?? "stopped"}`} />
                  <div className="grow">
                    <div className="title">
                      {p.name} <span className={`badge ${p.scope === "project" ? "accent" : ""}`}>{p.scope}</span>
                      {p.port && <span className="badge">:{p.port}</span>}
                    </div>
                    <div className="path">{p.command}</div>
                    {p.cwdError && <div className="sub err-text">{p.cwdError}</div>}
                  </div>
                  <button
                    className="icon-btn"
                    title="Start"
                    disabled={!!p.cwdError || live?.status === "running"}
                    onClick={async (e) => {
                      e.stopPropagation();
                      const t = await startProfile(project, p);
                      if (t) setTerm({ open: true, activeId: t.id });
                    }}
                  >
                    <Play size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          {draft ? (
            <div className="card">
              <div className="card-head">
                <h3 className="grow">{draft.previousName ? `Edit ${draft.previousName}` : "New profile"}</h3>
                {draft.previousName && (
                  <button className="btn sm danger" onClick={() => void remove(data!.profiles.find((p) => p.name === draft.previousName)!)}>
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </div>
              <div className="card-body form">
                <div className="grid-2">
                  <Field label="Name" error={nameClash ? "name already used" : undefined}>
                    <input className="input" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Metro" />
                  </Field>
                  <Field label="Saved in">
                    <select className="select" value={draft.scope} onChange={(e) => set("scope", e.target.value as Draft["scope"])}>
                      <option value="project">This project (.pi/terminals.json)</option>
                      <option value="global">Global (~/.pi/agent)</option>
                    </select>
                  </Field>
                </div>
                <Field label="Folder" hint={cwdCheck?.error ? undefined : cwdCheck ? `→ ${shortPath(cwdCheck.resolved, home)}` : "Relative to the project root, ~/… or absolute"} error={cwdCheck?.error}>
                  <div className="row">
                    <input className="input mono" value={draft.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="apps/mobile" />
                    <button
                      className="btn"
                      onClick={async () => {
                        const p = await pickFolder();
                        if (p) set("cwd", p.startsWith(project + "/") ? p.slice(project.length + 1) : p);
                      }}
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>
                </Field>
                <Field label="Command">
                  <input className="input mono" value={draft.command} onChange={(e) => set("command", e.target.value)} placeholder="npx react-native start --reset-cache" />
                </Field>
                <Field label="Environment">
                  <div className="col" style={{ gap: 6 }}>
                    {draft.env.map(([k, v], i) => (
                      <div className="env-row" key={i}>
                        <input className="input mono" value={k} placeholder="KEY" onChange={(e) => set("env", draft.env.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                        <input className="input mono" value={v} placeholder="value" onChange={(e) => set("env", draft.env.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                        <button className="icon-btn" onClick={() => set("env", draft.env.filter((_, j) => j !== i))}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => set("env", [...draft.env, ["", ""]])}>
                      <Plus size={12} /> Add variable
                    </button>
                  </div>
                </Field>
                <div className="grid-3">
                  <Field label="Port" hint="Checked before start" error={portErr}>
                    <input className="input" value={draft.port} onChange={(e) => set("port", e.target.value)} placeholder="8081" />
                  </Field>
                  <Field label="Autostart">
                    <div style={{ height: 32, display: "flex", alignItems: "center" }}>
                      <Toggle on={draft.autostart} onChange={(v) => set("autostart", v)} label="Autostart" />
                    </div>
                  </Field>
                  <Field label="Restart on exit">
                    <div style={{ height: 32, display: "flex", alignItems: "center" }}>
                      <Toggle on={draft.restartOnExit} onChange={(v) => set("restartOnExit", v)} label="Restart on exit" />
                    </div>
                  </Field>
                </div>
                <div className="form-actions">
                  <button className="btn" onClick={() => setDraft(undefined)}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={!draft.name.trim() || !draft.command.trim() || !!portErr || !!nameClash || !!cwdCheck?.error} onClick={() => void save()}>
                    Save profile
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-body">
                <Empty icon={<SquareTerminal size={22} />} title="Select a profile">
                  <p className="small">The agent can read any running terminal with its terminal_read tool — no more pasting Metro logs.</p>
                </Empty>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
