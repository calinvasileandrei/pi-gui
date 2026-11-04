import { useEffect, useMemo, useState } from "react";
import { Bot, Plus, Trash2 } from "lucide-react";
import { THINKING_LEVELS, type AgentDefinition, type ConfigError, type ExtensionInfo, type Model } from "@pi-gui/protocol";
import { act, confirmDialog, req, useApp } from "../store.ts";
import { Empty, Field, Toggle, baseName } from "../components/ui.tsx";
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
  const mcpServers = useMcp((s) => s.byRoot[project ?? ""]?.servers ?? []).filter((s) => s.status !== "disabled");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const r = await act(req<typeof data>("agents.list", { project }));
    if (r) setData(r);
    return r;
  };
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
          <button className="btn primary" onClick={() => setDraft(blank(project ? "project" : "global"))}>
            <Plus size={14} /> New agent
          </button>
        </div>
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
                  <p className="small">Create a read-only “scout” or a “reviewer” to start delegating.</p>
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
    </div>
  );
}
