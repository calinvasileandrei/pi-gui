import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileJson,
  Globe,
  Pencil,
  Play,
  Plug,
  Plus,
  RotateCw,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { McpServerConfig, McpServerInfo } from "@pi-gui/protocol";
import { act, confirmDialog, req, useApp } from "../store.ts";
import { refreshMcp, useMcp, useMcpSync } from "../mcp.ts";
import { CodeEditor } from "../components/DiffEditor.tsx";
import { Empty, Field, Modal, Toggle, shortPath } from "../components/ui.tsx";

type Scope = "global" | "project";
interface ImportSource {
  id: string;
  label: string;
  file: string;
  servers: Record<string, McpServerConfig>;
}

const STATUS_LABEL: Record<McpServerInfo["status"], string> = {
  idle: "not started",
  connecting: "connecting…",
  connected: "connected",
  error: "error",
  disabled: "disabled",
};
const STATUS_DOT: Record<McpServerInfo["status"], string> = {
  idle: "",
  connecting: "starting",
  connected: "idle",
  error: "crashed",
  disabled: "",
};

function summary(c: McpServerConfig) {
  if (c.command && !c.url) return [c.command, ...(c.args ?? [])].join(" ");
  return c.url ?? "";
}

export function McpPage() {
  const { project, home } = useApp();
  useMcpSync(project);
  const info = useMcp((s) => s.byRoot[project ?? ""]);
  const [edit, setEdit] = useState<{ server?: McpServerInfo; scope: Scope }>();
  const [importing, setImporting] = useState(false);
  const [rawScope, setRawScope] = useState<Scope>();
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const servers = info?.servers ?? [];
  const groups: [Scope, string, McpServerInfo[]][] = [
    ["project", "This project", servers.filter((s) => s.scope === "project")],
    ["global", "All projects", servers.filter((s) => s.scope === "global")],
  ];
  const t = (s: McpServerInfo) => ({ scope: s.scope, project, name: s.name });

  async function remove(s: McpServerInfo) {
    if (
      !(await confirmDialog({
        title: `Remove ${s.name}?`,
        body: `It is deleted from ${shortPath(s.file, home)}. Open sessions lose its tools on their next prompt.`,
        confirm: "Remove",
        danger: true,
      }))
    )
      return;
    await act(req("mcp.remove", t(s)), `Removed ${s.name}`);
    void refreshMcp(project);
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head mcp-head">
          <div className="grow">
            <h2>MCP servers</h2>
            <p>
              Tools from MCP servers become available to every session in the
              project, named <span className="mono">mcp__server__tool</span>.
              Changes apply on the next prompt — no restart. Same format as
              Claude Desktop and Cursor.
            </p>
          </div>
          <div className="row" style={{ gap: 8, flex: "none" }}>
            <button className="btn" onClick={() => setImporting(true)}>
              <Download size={14} /> Import
            </button>
            <button
              className="btn"
              onClick={() => setRawScope(project ? "project" : "global")}
              title="Edit mcp.json directly"
            >
              <FileJson size={14} /> JSON
            </button>
            <button
              className="btn primary"
              onClick={() => setEdit({ scope: project ? "project" : "global" })}
            >
              <Plus size={14} /> Add server
            </button>
          </div>
        </div>
        {info?.errors.map((e) => (
          <div
            key={e}
            className="banner err"
            style={{
              borderRadius: "var(--r)",
              border: "none",
              marginBottom: 12,
            }}
          >
            <AlertTriangle size={16} /> <span>{e}</span>
          </div>
        ))}
        {!info ? (
          <div className="empty-state">
            <span className="spinner" />
          </div>
        ) : servers.length === 0 ? (
          <div className="card">
            <Empty icon={<Plug size={22} />} title="No MCP servers yet">
              Add one, or import the servers you already set up in Claude
              Desktop, Cursor, VS Code or Claude Code.
              <div
                className="row"
                style={{ justifyContent: "center", marginTop: 12, gap: 8 }}
              >
                <button className="btn" onClick={() => setImporting(true)}>
                  <Download size={14} /> Import
                </button>
                <button
                  className="btn primary"
                  onClick={() =>
                    setEdit({ scope: project ? "project" : "global" })
                  }
                >
                  <Plus size={14} /> Add server
                </button>
              </div>
            </Empty>
          </div>
        ) : (
          groups.map(([scope, label, items]) =>
            scope === "project" && !project ? null : (
              <div className="card" key={scope}>
                <div className="card-head">
                  <h3>{label}</h3>
                  <span
                    className="faint small mono ellipsis grow"
                    title={
                      scope === "project"
                        ? `${project}/.pi/mcp.json`
                        : undefined
                    }
                  >
                    {scope === "project"
                      ? ".pi/mcp.json"
                      : "~/.pi/agent/mcp.json"}
                  </span>
                  <button
                    className="icon-btn"
                    title={`Add a server to ${label.toLowerCase()}`}
                    onClick={() => setEdit({ scope })}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {items.length === 0 && (
                  <div className="card-body faint small">
                    None
                    {scope === "project"
                      ? " — servers added here only load in this folder."
                      : "."}
                  </div>
                )}
                {items.map((s) => {
                  const k = s.scope + s.name;
                  const expanded = open[k] ?? s.status === "error";
                  const on = s.tools.filter((x) => x.enabled !== false).length;
                  const shadowed =
                    s.scope === "global" &&
                    servers.some(
                      (o) => o.scope === "project" && o.name === s.name,
                    );
                  return (
                    <div className="mcp-server" key={k}>
                      <div
                        className="list-item clickable"
                        onClick={() => setOpen({ ...open, [k]: !expanded })}
                      >
                        {expanded ? (
                          <ChevronDown size={14} className="faint" />
                        ) : (
                          <ChevronRight size={14} className="faint" />
                        )}
                        <span className="tool-icon">
                          {s.transport === "stdio" ? (
                            <Terminal size={14} />
                          ) : (
                            <Globe size={14} />
                          )}
                        </span>
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="title">
                            <span className={`dot ${STATUS_DOT[s.status]}`} />
                            {s.name}
                            <span
                              className={`badge ${s.status === "connected" ? "ok" : s.status === "error" ? "err" : ""}`}
                            >
                              {STATUS_LABEL[s.status]}
                            </span>
                            {s.status === "connected" && (
                              <span className="badge">
                                {on === s.tools.length
                                  ? s.tools.length
                                  : `${on}/${s.tools.length}`}{" "}
                                tool{s.tools.length === 1 ? "" : "s"}
                              </span>
                            )}
                            {s.transport !== "stdio" && (
                              <span className="badge">
                                {s.transport === "sse" ? "SSE" : "HTTP"}
                              </span>
                            )}
                            {shadowed && (
                              <span className="badge warn">
                                overridden by project
                              </span>
                            )}
                          </div>
                          <div className="path" title={summary(s.config)}>
                            {summary(s.config)}
                          </div>
                        </div>
                        <span
                          className="row"
                          style={{ gap: 2 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {s.status !== "disabled" &&
                            (s.status === "connected" ||
                            s.status === "connecting" ? (
                              <>
                                <button
                                  className="icon-btn"
                                  title="Restart"
                                  onClick={() =>
                                    void act(
                                      req("mcp.restart", {
                                        project,
                                        name: s.name,
                                      }),
                                      `${s.name} restarted`,
                                    )
                                  }
                                >
                                  <RotateCw size={14} />
                                </button>
                                <button
                                  className="icon-btn"
                                  title="Stop (starts again on the next prompt)"
                                  onClick={() =>
                                    void act(
                                      req("mcp.stop", {
                                        project,
                                        name: s.name,
                                      }),
                                    )
                                  }
                                >
                                  <Square size={13} />
                                </button>
                              </>
                            ) : (
                              <button
                                className="icon-btn"
                                title="Connect now"
                                onClick={() =>
                                  void act(
                                    req("mcp.restart", {
                                      project,
                                      name: s.name,
                                    }),
                                    `${s.name} connected`,
                                  )
                                }
                              >
                                <Play size={14} />
                              </button>
                            ))}
                          <button
                            className="icon-btn"
                            title="Edit"
                            onClick={() =>
                              setEdit({ server: s, scope: s.scope })
                            }
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="icon-btn"
                            title="Remove"
                            onClick={() => void remove(s)}
                          >
                            <Trash2 size={14} />
                          </button>
                          <Toggle
                            on={s.status !== "disabled"}
                            label={`Enable ${s.name}`}
                            onChange={(v) =>
                              void act(
                                req("mcp.setEnabled", { ...t(s), enabled: v }),
                              ).then(() => refreshMcp(project))
                            }
                          />
                        </span>
                      </div>
                      {expanded && (
                        <div className="mcp-detail">
                          {s.error && (
                            <pre className="mcp-error">{s.error}</pre>
                          )}
                          {s.status === "error" && s.stderr.length > 0 && (
                            <details>
                              <summary className="faint small">
                                Server log ({s.stderr.length} lines)
                              </summary>
                              <pre
                                className="source-view"
                                style={{ maxHeight: 180 }}
                              >
                                {s.stderr.join("\n")}
                              </pre>
                            </details>
                          )}
                          {s.status === "idle" && (
                            <div className="faint small">
                              Starts when a session in this project sends a
                              prompt, or press ▶ to connect now and list its
                              tools.
                            </div>
                          )}
                          {s.status === "connected" && s.serverName && (
                            <div className="faint small">
                              {s.serverName} {s.serverVersion}
                            </div>
                          )}
                          {s.status === "connected" && s.tools.length === 0 && (
                            <div className="faint small">
                              This server exposes no tools.
                            </div>
                          )}
                          {s.tools.map((tool) => (
                            <div className="mcp-tool" key={tool.name}>
                              <div className="grow" style={{ minWidth: 0 }}>
                                <div className="mono small">
                                  {tool.name}
                                  {tool.readOnly && (
                                    <span className="badge ok">read-only</span>
                                  )}
                                  {tool.destructive && (
                                    <span className="badge warn">
                                      destructive
                                    </span>
                                  )}
                                </div>
                                {tool.description && (
                                  <div className="faint small mcp-tool-desc">
                                    {tool.description}
                                  </div>
                                )}
                              </div>
                              <Toggle
                                on={tool.enabled !== false}
                                label={`Enable ${tool.name}`}
                                onChange={(v) =>
                                  void act(
                                    req("mcp.setToolEnabled", {
                                      ...t(s),
                                      tool: tool.name,
                                      enabled: v,
                                    }),
                                  ).then(() => refreshMcp(project))
                                }
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ),
          )
        )}
        <div className="hint faint small" style={{ marginTop: 14 }}>
          Values like <span className="mono">{"${GITHUB_TOKEN}"}</span> in env,
          headers, args or url are read from your shell environment, so secrets
          can stay out of the file. Subagents get MCP tools when their
          definition doesn't restrict tools, or lists them (e.g.{" "}
          <span className="mono">mcp__github__*</span>). Servers that need an
          OAuth sign-in aren't supported yet — use a token header.
        </div>
      </div>
      {edit && (
        <ServerEditor
          project={project}
          scope={edit.scope}
          server={edit.server}
          existing={servers}
          onClose={() => setEdit(undefined)}
        />
      )}
      {importing && (
        <ImportModal
          project={project}
          existing={servers}
          onClose={() => setImporting(false)}
        />
      )}
      {rawScope && (
        <RawEditor
          project={project}
          scope={rawScope}
          setScope={setRawScope}
          onClose={() => setRawScope(undefined)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- add / edit

type Pair = [string, string];
const toPairs = (m?: Record<string, string>): Pair[] => Object.entries(m ?? {});
const fromPairs = (p: Pair[]) =>
  Object.fromEntries(
    p.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]),
  );

/** split a shell-ish command line: quotes and backslash escapes, no expansion */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") ((q = ch), (any = true));
    else if (ch === "\\" && i + 1 < s.length) cur += s[++i];
    else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
const joinArgs = (a: string[]) =>
  a
    .map((x) =>
      /^[\w@%+=:,./-]+$/.test(x) ? x : `"${x.replace(/(["\\])/g, "\\$1")}"`,
    )
    .join(" ");

/** a README snippet: {"mcpServers":{name:{…}}}, {"servers":{…}}, {name:{…}} or a bare {command|url} */
function parseSnippet(
  text: string,
): { name?: string; config: McpServerConfig } | string {
  let j: any;
  try {
    j = JSON.parse(text.trim().replace(/,\s*([}\]])/g, "$1"));
  } catch {
    const t = text.trim();
    if (/^(npx|uvx|node|python3?|docker|bunx|deno)\s/.test(t)) {
      const [command, ...args] = splitArgs(t);
      return { config: { command, args } };
    }
    if (/^https?:\/\//.test(t)) return { config: { url: t } };
    return "Not JSON, a command line, or a URL";
  }
  if (!j || typeof j !== "object") return "Expected a JSON object";
  const inner = j.mcpServers ?? j.servers ?? j.mcp?.servers ?? j;
  if (inner.command || inner.url) return { config: inner };
  const entries = Object.entries(inner).filter(
    ([, v]) =>
      v &&
      typeof v === "object" &&
      ((v as McpServerConfig).command || (v as McpServerConfig).url),
  );
  if (!entries.length) return "No server entry (with a command or url) found";
  const [name, config] = entries[0] as [string, McpServerConfig];
  return { name, config };
}

function ServerEditor({
  project,
  scope: scope0,
  server,
  existing,
  onClose,
}: {
  project?: string;
  scope: Scope;
  server?: McpServerInfo;
  existing: McpServerInfo[];
  onClose: () => void;
}) {
  const c0 = server?.config ?? {};
  const [scope, setScope] = useState<Scope>(scope0);
  const [name, setName] = useState(server?.name ?? "");
  const [kind, setKind] = useState<"stdio" | "remote">(
    c0.url && !c0.command ? "remote" : "stdio",
  );
  const [cmd, setCmd] = useState(
    c0.command ? joinArgs([c0.command, ...(c0.args ?? [])]) : "",
  );
  const [cwd, setCwd] = useState(c0.cwd ?? "");
  const [env, setEnv] = useState<Pair[]>(toPairs(c0.env));
  const [url, setUrl] = useState(c0.url ?? "");
  const [transport, setTransport] = useState<"auto" | "http" | "sse">(
    c0.type === "sse"
      ? "sse"
      : c0.type === "http" || c0.type === "streamable-http"
        ? "http"
        : "auto",
  );
  const [headers, setHeaders] = useState<Pair[]>(toPairs(c0.headers));
  const [timeout, setTimeoutS] = useState(
    c0.timeout ? String(Math.round(c0.timeout / 1000)) : "",
  );
  const [paste, setPaste] = useState("");
  const [pasteErr, setPasteErr] = useState<string>();
  const [saving, setSaving] = useState(false);

  const nameErr = !name
    ? undefined
    : !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(name)
      ? "letters, digits, . _ - (max 48)"
      : existing.some(
            (s) => s.scope === scope && s.name === name && s !== server,
          )
        ? "a server with this name already exists here"
        : undefined;
  const argv = useMemo(() => splitArgs(cmd), [cmd]);
  const valid =
    !!name &&
    !nameErr &&
    (kind === "stdio" ? argv.length > 0 : /^https?:\/\/.+/.test(url.trim()));

  function applySnippet(text: string) {
    setPaste(text);
    if (!text.trim()) return setPasteErr(undefined);
    const r = parseSnippet(text);
    if (typeof r === "string") return setPasteErr(r);
    setPasteErr(undefined);
    const c = r.config;
    if (r.name && !name) setName(r.name.replace(/[^A-Za-z0-9_.-]/g, "-"));
    if (c.url && !c.command) {
      setKind("remote");
      setUrl(c.url);
      setHeaders(toPairs(c.headers));
      setTransport(
        c.type === "sse"
          ? "sse"
          : c.type === "http" || c.type === "streamable-http"
            ? "http"
            : "auto",
      );
    } else if (c.command) {
      setKind("stdio");
      setCmd(joinArgs([c.command, ...(c.args ?? [])]));
      setEnv(toPairs(c.env));
      setCwd(c.cwd ?? "");
    }
  }

  async function save() {
    // keep fields this form doesn't edit (disabled, disabledTools, unknown keys)
    const base: McpServerConfig = { ...c0 };
    (delete base.command,
      delete base.args,
      delete base.env,
      delete base.cwd,
      delete base.url,
      delete base.headers,
      delete base.type,
      delete base.timeout);
    const config: McpServerConfig =
      kind === "stdio"
        ? {
            ...base,
            command: argv[0],
            args: argv.slice(1),
            env: fromPairs(env),
            cwd: cwd.trim() || undefined,
          }
        : {
            ...base,
            url: url.trim(),
            headers: fromPairs(headers),
            type: transport === "auto" ? undefined : transport,
          };
    if (timeout.trim()) config.timeout = Math.max(1, Number(timeout)) * 1000;
    setSaving(true);
    const moved = server && server.scope !== scope;
    const r = await act(
      req("mcp.save", {
        scope,
        project,
        name,
        config,
        oldName: !moved && server?.name !== name ? server?.name : undefined,
      }),
      `Saved ${name}`,
    );
    if (r && moved)
      await act(
        req("mcp.remove", { scope: server.scope, project, name: server.name }),
      );
    setSaving(false);
    if (r) {
      void refreshMcp(project);
      onClose();
    }
  }

  return (
    <Modal wide onClose={onClose}>
      <div className="modal-head">
        <div className="modal-icon">
          <Plug size={17} />
        </div>
        <div className="grow">
          <h3>{server ? `Edit ${server.name}` : "Add MCP server"}</h3>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="modal-body form">
        {!server && (
          <Field
            label="Paste from a README (optional)"
            hint={
              pasteErr
                ? undefined
                : "JSON config, an npx/uvx command, or a URL — fills in the form below."
            }
            error={pasteErr}
          >
            <textarea
              className="input mono"
              rows={3}
              placeholder={
                '{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }'
              }
              value={paste}
              onChange={(e) => applySnippet(e.target.value)}
            />
          </Field>
        )}
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="grow">
            <Field label="Name" error={nameErr}>
              <input
                className="input mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="github"
                autoFocus={!!server}
              />
            </Field>
          </div>
          <Field label="Available in">
            <select
              className="select"
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
            >
              <option value="project" disabled={!project}>
                This project
              </option>
              <option value="global">All projects</option>
            </select>
          </Field>
        </div>
        <div className="seg" style={{ alignSelf: "flex-start" }}>
          <button
            className={kind === "stdio" ? "on" : ""}
            onClick={() => setKind("stdio")}
          >
            <Terminal size={13} /> Local command
          </button>
          <button
            className={kind === "remote" ? "on" : ""}
            onClick={() => setKind("remote")}
          >
            <Globe size={13} /> Remote URL
          </button>
        </div>
        {kind === "stdio" ? (
          <>
            <Field
              label="Command"
              hint={
                argv.length > 1 ? (
                  <span className="mono">
                    {argv[0]} · {argv.length - 1} arg
                    {argv.length === 2 ? "" : "s"}
                  </span>
                ) : (
                  "The program and its arguments, as you'd type them in a terminal."
                )
              }
            >
              <input
                className="input mono"
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                placeholder="npx -y @modelcontextprotocol/server-filesystem ."
              />
            </Field>
            <Field
              label="Environment variables"
              hint="Use ${NAME} to read a value from your shell instead of storing it here."
            >
              <PairsEditor
                pairs={env}
                setPairs={setEnv}
                keyPh="GITHUB_TOKEN"
                valPh="${GITHUB_TOKEN}"
                secret
              />
            </Field>
            <Field
              label="Working directory"
              hint="Defaults to the project folder. Relative paths are from the project."
            >
              <input
                className="input mono"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="(project folder)"
              />
            </Field>
          </>
        ) : (
          <>
            <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
              <div className="grow">
                <Field label="URL">
                  <input
                    className="input mono"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                  />
                </Field>
              </div>
              <Field label="Transport">
                <select
                  className="select"
                  value={transport}
                  onChange={(e) =>
                    setTransport(e.target.value as typeof transport)
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="http">Streamable HTTP</option>
                  <option value="sse">SSE (legacy)</option>
                </select>
              </Field>
            </div>
            <Field
              label="Headers"
              hint="e.g. Authorization: Bearer ${API_TOKEN}"
            >
              <PairsEditor
                pairs={headers}
                setPairs={setHeaders}
                keyPh="Authorization"
                valPh="Bearer ${API_TOKEN}"
                secret
              />
            </Field>
          </>
        )}
        <Field label="Tool call timeout (seconds)" hint="Default 300.">
          <input
            className="input"
            style={{ width: 120 }}
            inputMode="numeric"
            value={timeout}
            onChange={(e) => setTimeoutS(e.target.value.replace(/\D/g, ""))}
            placeholder="300"
          />
        </Field>
        {kind === "stdio" && (
          <div
            className="banner warn small"
            style={{ borderRadius: "var(--r-sm)", border: "none" }}
          >
            <AlertTriangle size={14} />{" "}
            <span>
              Local servers run with your full permissions. Only add servers you
              trust.
            </span>
          </div>
        )}
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!valid || saving}
          onClick={() => void save()}
        >
          {saving && <span className="spinner" />}{" "}
          {server ? "Save" : "Add & connect"}
        </button>
      </div>
    </Modal>
  );
}

function PairsEditor({
  pairs,
  setPairs,
  keyPh,
  valPh,
  secret,
}: {
  pairs: Pair[];
  setPairs: (p: Pair[]) => void;
  keyPh: string;
  valPh: string;
  secret?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const rows = pairs.length ? pairs : [];
  const set = (i: number, j: 0 | 1, v: string) =>
    setPairs(
      rows.map((p, k) =>
        k === i ? ((j === 0 ? [v, p[1]] : [p[0], v]) as Pair) : p,
      ),
    );
  return (
    <div className="pairs">
      {rows.map(([k, v], i) => (
        <div className="row" key={i} style={{ gap: 6 }}>
          <input
            className="input mono"
            style={{ flex: "0 0 38%" }}
            value={k}
            placeholder={keyPh}
            onChange={(e) => set(i, 0, e.target.value)}
          />
          <input
            className="input mono grow"
            type={
              secret && !reveal && !/^\$\{[^}]+\}$/.test(v) && v
                ? "password"
                : "text"
            }
            value={v}
            placeholder={valPh}
            onChange={(e) => set(i, 1, e.target.value)}
          />
          <button
            className="icon-btn"
            title="Remove"
            onClick={() => setPairs(rows.filter((_, k2) => k2 !== i))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn sm ghost"
          onClick={() => setPairs([...rows, ["", ""]])}
        >
          <Plus size={13} /> Add
        </button>
        {secret && rows.some(([, v]) => v && !/^\$\{[^}]+\}$/.test(v)) && (
          <button className="btn sm ghost" onClick={() => setReveal(!reveal)}>
            {reveal ? "Hide values" : "Show values"}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- import

function ImportModal({
  project,
  existing,
  onClose,
}: {
  project?: string;
  existing: McpServerInfo[];
  onClose: () => void;
}) {
  const { home } = useApp();
  const [sources, setSources] = useState<ImportSource[]>();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<Scope>("global");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void req<ImportSource[]>("mcp.importSources", { project }).then(
      setSources,
      (e) => (useApp.getState().toast("error", e.message), setSources([])),
    );
  }, [project]);
  const has = (n: string) =>
    existing.some((s) => s.scope === scope && s.name === n);
  const count = Object.values(picked).filter(Boolean).length;

  async function run() {
    setBusy(true);
    let added = 0;
    for (const src of sources ?? []) {
      const names = Object.keys(src.servers).filter(
        (n) => picked[`${src.id}/${n}`],
      );
      if (!names.length) continue;
      const r = await act(
        req<{ added: string[]; skipped: string[] }>("mcp.import", {
          source: src.id,
          names,
          scope,
          project,
          overwrite: true,
        }),
      );
      added += r?.added.length ?? 0;
    }
    setBusy(false);
    useApp
      .getState()
      .toast("success", `Imported ${added} server${added === 1 ? "" : "s"}`);
    void refreshMcp(project);
    onClose();
  }

  return (
    <Modal wide onClose={onClose}>
      <div className="modal-head">
        <div className="modal-icon">
          <Download size={17} />
        </div>
        <div className="grow">
          <h3>Import MCP servers</h3>
          <p className="small faint">
            From config files other apps on this Mac already have. Entries are
            copied — the originals aren't changed.
          </p>
        </div>
      </div>
      <div className="modal-body col">
        {!sources ? (
          <span className="spinner" />
        ) : sources.length === 0 ? (
          <div className="faint small">
            Didn't find any MCP configs (looked for Claude Desktop, Cursor,
            Windsurf, VS Code, Claude Code
            {project
              ? ", and this project's .mcp.json / .cursor / .vscode"
              : ""}
            ).
          </div>
        ) : (
          sources.map((src) => (
            <div key={src.id} className="import-src">
              <div className="row" style={{ gap: 8 }}>
                <b className="small">{src.label}</b>
                <span className="faint small mono ellipsis grow">
                  {shortPath(src.file, home)}
                </span>
                <button
                  className="btn sm ghost"
                  onClick={() =>
                    setPicked({
                      ...picked,
                      ...Object.fromEntries(
                        Object.keys(src.servers).map((n) => [
                          `${src.id}/${n}`,
                          true,
                        ]),
                      ),
                    })
                  }
                >
                  All
                </button>
              </div>
              {Object.entries(src.servers).map(([n, c]) => (
                <label key={n} className="import-row">
                  <input
                    type="checkbox"
                    checked={!!picked[`${src.id}/${n}`]}
                    onChange={(e) =>
                      setPicked({
                        ...picked,
                        [`${src.id}/${n}`]: e.target.checked,
                      })
                    }
                  />
                  <span className="mono small">{n}</span>
                  {has(n) && (
                    <span className="badge warn">replaces existing</span>
                  )}
                  <span className="faint small mono ellipsis grow">
                    {summary(c)}
                  </span>
                </label>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="modal-foot">
        <select
          className="select"
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
        >
          <option value="global">Into: all projects</option>
          <option value="project" disabled={!project}>
            Into: this project
          </option>
        </select>
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!count || busy}
          onClick={() => void run()}
        >
          {busy && <span className="spinner" />} Import {count || ""}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- raw JSON

function RawEditor({
  project,
  scope,
  setScope,
  onClose,
}: {
  project?: string;
  scope: Scope;
  setScope: (s: Scope) => void;
  onClose: () => void;
}) {
  const { home } = useApp();
  const [file, setFile] = useState<{ file: string; text: string }>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFile(undefined);
    void req<{ file: string; text: string }>("mcp.readFile", {
      scope,
      project,
    }).then(
      (f) => (setFile(f), setText(f.text)),
      (e) => useApp.getState().toast("error", e.message),
    );
  }, [scope, project]);
  const err = useMemo(() => {
    try {
      JSON.parse(text);
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }, [text]);

  async function save() {
    setBusy(true);
    const r = await act(
      req("mcp.writeFile", { scope, project, text }),
      "Saved",
    );
    setBusy(false);
    if (r) {
      void refreshMcp(project);
      onClose();
    }
  }

  return (
    <Modal wide onClose={onClose} className="raw-json-modal">
      <div className="modal-head">
        <div className="modal-icon">
          <FileJson size={17} />
        </div>
        <div className="grow">
          <h3>Edit mcp.json</h3>
          <p className="mono small">
            {file ? shortPath(file.file, home) : "…"}
          </p>
        </div>
        <div className="seg">
          <button
            className={scope === "project" ? "on" : ""}
            disabled={!project}
            onClick={() => setScope("project")}
          >
            This project
          </button>
          <button
            className={scope === "global" ? "on" : ""}
            onClick={() => setScope("global")}
          >
            Global
          </button>
        </div>
      </div>
      <div className="raw-json-host">
        {file ? (
          <CodeEditor
            key={file.file}
            value={file.text}
            language="json"
            path={file.file}
            onChange={setText}
            onSave={() => !err && void save()}
          />
        ) : (
          <span className="spinner" />
        )}
      </div>
      <div className="modal-foot">
        {err ? (
          <span className="small" style={{ color: "var(--err)" }}>
            {err}
          </span>
        ) : (
          <span className="faint small">⌘S to save</span>
        )}
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!!err || busy || text === file?.text}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
