import { useEffect, useMemo, useState } from "react";
import { Bot, Download, Plus, Trash2 } from "lucide-react";
import { THINKING_LEVELS, type AgentDefinition, type ConfigError, type ExtensionInfo, type Model } from "@pi-gui/protocol";
import { act, confirmDialog, req, useApp } from "../store.ts";
import { Empty, Field, Modal, Toggle, baseName, shortPath } from "../components/ui.tsx";
import { ImportHint } from "../components/ImportHint.tsx";

interface ImportedAgent {
  name: string;
  description: string;
  tools?: string[];
  canSpawn: boolean;
  systemPrompt: string;
  notes: string[];
  file: string;
}
interface AgentSource {
  id: string;
  label: string;
  path: string;
  agents: ImportedAgent[];
}
const appOf = (label: string) => label.replace(/^This project · /, "").replace(/ · .*$/, "");
import { useMcp } from "../mcp.ts";

const BUILTIN = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BRIDGE = ["subagent", "notes_read", "notes_append", "terminal_read", "message_parent", "ask_parent"];
const READ_ONLY = ["read", "grep", "find", "ls"];

type Draft = Omit<AgentDefinition, "file"> & { file?: string };
const blank = (scope: "project" | "global"): Draft => ({ name: "", description: "", tools: [...READ_ONLY], extensions: [], canSpawn: false, systemPrompt: "", scope, maxTurns: 30 });

export function AgentsPage() {
  const { project, sessions } = useApp();
  const [data, setData] = useState<{ agents: AgentDefinition[]; errors: ConfigError[] }>({ agents: [], errors: [] });
  const [draft, setDraft] = useState<Draft>();
  const [models, setModels] = useState<Model[]>([]);
  const [exts, setExts] = useState<ExtensionInfo[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  // select the stored array itself: a fresh `[]` per call makes the store look changed on every render
  const mcpAll = useMcp((s) => s.byRoot[project ?? ""]?.servers);
  const mcpServers = (mcpAll ?? []).filter((s) => s.status !== "disabled");
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    // deep link #import=1 (self-screenshot checks)
    const on = () => /[#&]import=1/.test(location.hash) && setImporting(true);
    on();
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const load = async () => {
    const r = await act(req<typeof data>("agents.list", { project }));
    if (r) setData(r);
    return r;
  };
  useEffect(() => {
    void req<AgentSource[]>("agents.importSources", { project }).then(setSources, () => setSources([]));
  }, [project, data.agents.length]);
  const fresh = new Map<string, Set<string>>();
  for (const src of sources) for (const a of src.agents) if (!data.agents.some((x) => x.name.toLowerCase() === a.name)) (fresh.get(a.name) ?? fresh.set(a.name, new Set()).get(a.name)!).add(appOf(src.label));
  const freshFrom = [...new Set([...fresh.values()].flatMap((x) => [...x]))];
  useEffect(() => {
    void load();
    void req<ExtensionInfo[]>("ext.list", { project }).then(setExts, () => {});
    const live = sessions.find((s) => !s.parentId && (s.status === "idle" || s.status === "streaming"));
    if (live) void req<Model[]>("session.models", { id: live.id }).then(setModels, () => {});
  }, [project]);

  const modelKeys = useMemo(() => models.map((m) => `${m.provider}/${m.id}`), [models]);
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => {
      void req<string[]>("agents.validate", { agent: { name: draft.name || "x", tools: draft.tools, model: draft.model }, models: modelKeys }).then(setProblems, () => {});
    }, 200);
    return () => clearTimeout(t);
  }, [draft?.name, draft?.tools, draft?.model, modelKeys]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const toggleIn = (k: "tools" | "extensions", v: string) => setDraft((d) => (d ? { ...d, [k]: (d[k] ?? []).includes(v) ? (d[k] ?? []).filter((x) => x !== v) : [...(d[k] ?? []), v] } : d));
  const nameClash = draft && data.agents.some((a) => a.name.toLowerCase() === draft.name.toLowerCase() && a.file !== draft.file && a.scope === draft.scope);
  const nameError = draft && draft.name && !/^[a-z0-9][a-z0-9_-]*$/i.test(draft.name) ? "letters, digits, - and _ only" : nameClash ? "an agent with this name already exists" : undefined;
  const writes = draft?.tools?.some((t) => ["edit", "write", "bash"].includes(t));

  async function save() {
    if (!draft) return;
    setSaving(true);
    const { file, ...agent } = draft;
    const r = await act(req("agents.save", { project, previousFile: file, agent }), `Saved ${draft.name}`);
    setSaving(false);
    if (r) {
      const d = await load();
      const saved = d?.agents.find((a) => a.name === draft.name);
      if (saved) setDraft(saved);
    }
  }
  async function remove(a: AgentDefinition) {
    if (!(await confirmDialog({ title: `Delete agent “${a.name}”?`, body: a.file, confirm: "Delete", danger: true }))) return;
    if (await act(req("agents.delete", { file: a.file, project }), "Deleted")) {
      setDraft(undefined);
      void load();
    }
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h2>Agents</h2>
            <p>
              Subagent definitions pi can delegate to. Stored as Markdown in <code>.pi/agents/</code> (project) or <code>~/.pi/agent/agents/</code> (global) — the project wins on a name clash. Changes apply on the next spawn.
            </p>
          </div>
          <div className="row" style={{ gap: 8, flex: "none" }}>
            <button className="btn" onClick={() => setImporting(true)} title="Bring over subagents from Claude Code, OpenCode or GitHub Copilot">
              <Download size={14} /> Import
            </button>
            <button className="btn primary" onClick={() => setDraft(blank(project ? "project" : "global"))}>
              <Plus size={14} /> New agent
            </button>
          </div>
        </div>
        {data.agents.length > 0 && <ImportHint kind="agent" items={[...fresh.keys()]} from={freshFrom} onReview={() => setImporting(true)} />}
        {data.errors.length > 0 && (
          <div className="config-errors">
            {data.errors.map((e, i) => (
              <div key={i}>
                <span className="file">{e.file}</span> — {e.message}
              </div>
            ))}
          </div>
        )}
        <div className="split">
          <div className="card">
            {data.agents.length === 0 && (
              <div className="card-body">
                <Empty icon={<Bot size={22} />} title="No agents yet">
                  {fresh.size > 0 ? (
                    <>
                      <p className="small">{`Found ${fresh.size} agent${fresh.size === 1 ? "" : "s"} in ${freshFrom.join(", ")}.`}</p>
                      <button className="btn primary" style={{ marginTop: 8 }} onClick={() => setImporting(true)}>
                        <Download size={14} /> Import them
                      </button>
                    </>
                  ) : (
                    <p className="small">Create a read-only “scout” or a “reviewer” to start delegating, or import the subagents you made in Claude Code, OpenCode or GitHub Copilot.</p>
                  )}
                </Empty>
              </div>
            )}
            {data.agents.map((a) => (
              <div key={a.file} className={`list-item clickable ${draft?.file === a.file ? "selected" : ""}`} onClick={() => setDraft(a)}>
                <span className="avatar agent">{a.name[0]?.toUpperCase()}</span>
                <div className="grow">
                  <div className="title">
                    {a.name} <span className={`badge ${a.scope === "project" ? "accent" : ""}`}>{a.scope}</span>
                  </div>
                  <div className="sub">{a.description || "No description"}</div>
                </div>
              </div>
            ))}
          </div>
          {draft ? (
            <div className="card">
              <div className="card-head">
                <h3 className="grow">{draft.file ? `Edit ${draft.name}` : "New agent"}</h3>
                {draft.file && (
                  <button className="btn sm danger" onClick={() => void remove(draft as AgentDefinition)}>
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </div>
              <div className="card-body form">
                <div className="grid-2">
                  <Field label="Name" error={nameError}>
                    <input className="input" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="reviewer" />
                  </Field>
                  <Field label="Scope" hint={draft.scope === "project" ? project : "~/.pi/agent/agents"}>
                    <select className="select" value={draft.scope} onChange={(e) => set("scope", e.target.value as "project" | "global")} disabled={!!draft.file}>
                      <option value="project" disabled={!project}>
                        Project{project ? ` (${baseName(project)})` : ""}
                      </option>
                      <option value="global">Global</option>
                    </select>
                  </Field>
                </div>
                <Field label="Description" hint="Shown to the parent model when it decides whom to delegate to.">
                  <input className="input" value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="Reviews diffs for bugs and style issues" />
                </Field>
                <div className="grid-2">
                  <Field label="Model" hint={models.length ? "Any logged-in provider" : "Open a session to list available models"} error={problems.find((p) => p.startsWith("model"))}>
                    <input className="input" list="agent-models" value={draft.model ?? ""} onChange={(e) => set("model", e.target.value || undefined)} placeholder="inherit (pi default)" />
                    <datalist id="agent-models">
                      {modelKeys.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </Field>
                  <Field label="Thinking">
                    <select className="select" value={draft.thinking ?? ""} onChange={(e) => set("thinking", (e.target.value || undefined) as Draft["thinking"])}>
                      <option value="">inherit</option>
                      {THINKING_LEVELS.map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Tools" hint={writes ? "Can modify files — only one writing subagent runs at a time." : "Read-only — safe to run several in parallel."} error={problems.find((p) => p.startsWith("unknown tool"))}>
                  <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                    {[...BUILTIN, ...BRIDGE.filter((t) => !["message_parent", "ask_parent", "notes_read", "notes_append"].includes(t))].map((t) => (
                      <label key={t} className={`check ${draft.tools?.includes(t) ? "on" : ""}`} onClick={() => toggleIn("tools", t)}>
                        {t}
                      </label>
                    ))}
                  </div>
                  {mcpServers.length > 0 && (
                    <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                      <span className="faint small">MCP:</span>
                      {mcpServers.map((m) => {
                        const pat = `mcp__${m.name.replace(/[^A-Za-z0-9_-]/g, "_")}__*`;
                        return (
                          <label key={m.scope + m.name} title={`All tools of ${m.name} (${pat})`} className={`check ${draft.tools?.includes(pat) ? "on" : ""}`} onClick={() => toggleIn("tools", pat)}>
                            {m.name}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </Field>
                {exts.filter((e) => !e.builtin && e.source !== "package").length > 0 && (
                  <Field label="Extension allowlist" hint="Subagents load only gui-bridge plus the extensions ticked here.">
                    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                      {exts
                        .filter((e) => !e.builtin && e.source !== "package")
                        .map((e) => (
                          <label key={e.path} className={`check ${draft.extensions?.includes(e.name) ? "on" : ""}`} onClick={() => toggleIn("extensions", e.name)}>
                            {e.name}
                          </label>
                        ))}
                    </div>
                  </Field>
                )}
                <div className="grid-3">
                  <Field label="Max turns">
                    <input className="input" type="number" min={1} value={draft.maxTurns ?? ""} onChange={(e) => set("maxTurns", e.target.value ? Number(e.target.value) : undefined)} />
                  </Field>
                  <Field label="Time limit (s)">
                    <input className="input" type="number" min={10} value={draft.timeoutSec ?? ""} placeholder="900" onChange={(e) => set("timeoutSec", e.target.value ? Number(e.target.value) : undefined)} />
                  </Field>
                  <Field label="Can spawn subagents">
                    <div style={{ height: 32, display: "flex", alignItems: "center" }}>
                      <Toggle on={draft.canSpawn} onChange={(v) => set("canSpawn", v)} label="Can spawn subagents" />
                    </div>
                  </Field>
                </div>
                <Field label="System prompt" hint="Appended to pi's system prompt for this agent.">
                  <textarea className="textarea mono" rows={9} value={draft.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} placeholder="You review code changes. Report issues with file and line references…" />
                </Field>
                <div className="form-actions">
                  <button className="btn" onClick={() => setDraft(undefined)}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={!draft.name || !!nameError || problems.some((p) => p.startsWith("unknown")) || saving} onClick={() => void save()}>
                    {saving ? "Saving…" : "Save agent"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-body">
                <Empty icon={<Bot size={22} />} title="Select or create an agent">
                  <p className="small">Agents run in their own pi process with their own model, tools and prompt, and report back to the parent.</p>
                </Empty>
              </div>
            </div>
          )}
        </div>
      </div>
      {importing && (
        <AgentImportModal
          project={project}
          existing={data.agents}
          onClose={() => setImporting(false)}
          onDone={() => void load()}
        />
      )}
    </div>
  );
}

function AgentImportModal({ project, existing, onClose, onDone }: { project?: string; existing: AgentDefinition[]; onClose: () => void; onDone: () => void }) {
  const { home } = useApp();
  const [sources, setSources] = useState<AgentSource[]>();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<"global" | "project">(project ? "project" : "global");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void req<AgentSource[]>("agents.importSources", { project }).then(
      (list) => {
        setSources(list);
        const pre: Record<string, boolean> = {};
        const seen = new Set(existing.map((a) => a.name.toLowerCase()));
        for (const src of list) for (const a of src.agents) if (!seen.has(a.name)) (seen.add(a.name), (pre[`${src.id}/${a.name}`] = true));
        setPicked(pre);
      },
      (e) => (useApp.getState().toast("error", (e as Error).message), setSources([])),
    );
  }, [project]);
  const has = (n: string) => existing.some((a) => a.scope === scope && a.name.toLowerCase() === n);
  const count = Object.values(picked).filter(Boolean).length;

  async function run() {
    setBusy(true);
    let added = 0;
    for (const src of sources ?? []) {
      const names = src.agents.map((a) => a.name).filter((n) => picked[`${src.id}/${n}`]);
      if (!names.length) continue;
      const r = await act(req<{ added: string[] }>("agents.import", { source: src.id, names, scope, project, overwrite: true }));
      added += r?.added.length ?? 0;
    }
    setBusy(false);
    useApp.getState().toast("success", `Imported ${added} agent${added === 1 ? "" : "s"}`);
    onDone();
    onClose();
  }

  return (
    <Modal wide onClose={onClose}>
      <div className="modal-head">
        <div className="modal-icon">
          <Download size={17} />
        </div>
        <div className="grow">
          <h3>Import agents</h3>
          <p className="small faint">Subagents from other coding tools, converted to pi's format. The originals aren't changed.</p>
        </div>
      </div>
      <div className="modal-body col">
        {!sources ? (
          <span className="spinner" />
        ) : sources.length === 0 ? (
          <div className="faint small">
            Didn't find any. Looked in <span className="mono">~/.claude/agents</span>, OpenCode's <span className="mono">agent/</span> folder and <span className="mono">opencode.json</span>
            {project ? (
              <>
                , and this project's <span className="mono">.claude/agents</span>, <span className="mono">.opencode/agent</span> and <span className="mono">.github/agents</span>
              </>
            ) : null}
            .
          </div>
        ) : (
          sources.map((src) => (
            <div key={src.id} className="import-src">
              <div className="row" style={{ gap: 8 }}>
                <b className="small">{src.label}</b>
                <span className="faint small mono ellipsis grow">{shortPath(src.path, home)}</span>
                <button className="btn sm ghost" onClick={() => setPicked({ ...picked, ...Object.fromEntries(src.agents.map((a) => [`${src.id}/${a.name}`, true])) })}>
                  All
                </button>
              </div>
              {src.agents.map((a) => {
                const k = `${src.id}/${a.name}`;
                return (
                  <div key={a.name}>
                    <label className="import-row" title={a.file}>
                      <input type="checkbox" checked={!!picked[k]} onChange={(e) => setPicked({ ...picked, [k]: e.target.checked })} />
                      <span className="mono small">{a.name}</span>
                      {has(a.name) && <span className="badge warn">replaces existing</span>}
                      <span className="faint small ellipsis grow">{a.description}</span>
                      <span className="faint small mono" style={{ flex: "none" }}>
                        {a.tools ? (a.tools.length ? a.tools.filter((t) => !t.startsWith("mcp__")).join(" ") || "MCP only" : "no tools") : "all tools"}
                      </span>
                    </label>
                    {picked[k] && a.notes.length > 0 && (
                      <div className="import-notes">
                        {a.notes.map((n) => (
                          <span key={n}>{n}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="modal-foot">
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value as "global" | "project")}>
          <option value="global">Into: all projects</option>
          <option value="project" disabled={!project}>
            Into: this project
          </option>
        </select>
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!count || busy} onClick={() => void run()}>
          {busy && <span className="spinner" />} Import {count || ""}
        </button>
      </div>
    </Modal>
  );
}
