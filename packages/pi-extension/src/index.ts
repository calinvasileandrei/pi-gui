// gui-bridge: the one pi extension pi-gui ships (plan §2). Loaded into every pi the GUI starts.
// Talks to the GUI server over loopback HTTP with the per-launch token. Does nothing outside the GUI.
import { request } from "node:http";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

interface Cfg {
  url?: string;
  token?: string;
  sessionId?: string;
}
// pi-boot.mjs moves the token out of process.env (so the agent's shell never sees it) into this global
const cfg: Cfg = (globalThis as { __piGui?: Cfg }).__piGui ?? {
  url: process.env.PI_GUI_URL,
  token: process.env.PI_GUI_TOKEN,
  sessionId: process.env.PI_GUI_SESSION_ID,
};
const isSubagent = !!process.env.PI_GUI_RUN_ID;

/** node:http, not fetch: pi may install a proxying global dispatcher that must not see loopback calls. */
function call<T = unknown>(op: string, args: unknown, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(`/api/${op}`, cfg.url);
    const body = JSON.stringify(args ?? {});
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-pi-gui-session": cfg.sessionId ?? "",
        },
        signal,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data) as { ok: boolean; data?: T; error?: string };
            j.ok ? resolve(j.data as T) : reject(new Error(j.error ?? `GUI error ${res.statusCode}`));
          } catch {
            reject(new Error(`GUI returned ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export default async function guiBridge(pi: ExtensionAPI) {
  if (!cfg.url || !cfg.token) return; // plain pi in a terminal: stay inert

  // ---- pre-edit snapshot + optional approval gate (blocking, so it's exact) ----
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input as Record<string, unknown>;
    if (typeof input.path !== "string") return;
    try {
      const r = await call<{ block: boolean; reason?: string }>("bridge.beforeWrite", { tool: event.toolName, path: input.path, input, cwd: ctx.cwd });
      if (r.block) return { block: true, reason: r.reason ?? "Rejected in the GUI" };
    } catch {
      /* GUI unreachable: never block the agent because of us */
    }
    return undefined;
  });

  // ---- subagents ----
  let agentList = "";
  try {
    const agents = await call<{ name: string; description: string }[]>("bridge.agents", {});
    agentList = agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`).join("\n");
  } catch {
    /* listed lazily on error */
  }
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a self-contained task to a specialised subagent that runs in its own clean context and returns a structured report " +
      "(summary, files touched, findings, open questions). Give it everything it needs in `task`/`context`; it cannot see this conversation. " +
      "Several subagent calls in one turn run in parallel." +
      (agentList ? `\n\nAvailable agents:\n${agentList}` : ""),
    promptSnippet: "Delegate focused work to a subagent (own context, returns a report)",
    promptGuidelines: [
      "Use subagent for self-contained research, review or exploration tasks so this context stays small; call it several times in one turn to parallelise read-only work.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Agent definition name" }),
      task: Type.String({ description: "What to do, with acceptance criteria" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths for the subagent to read" })),
      context: Type.Optional(Type.String({ description: "Decisions so far and constraints" })),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      onUpdate?.(text(`Delegating to ${params.agent}…`));
      const r = await call<{ text: string; runId: string; status: string }>("bridge.subagent", { ...params, toolCallId }, signal);
      if (r.status !== "done") throw new Error(r.text); // crash/abort/timeout → failed tool result; parent continues
      return { content: [{ type: "text", text: r.text }], details: { runId: r.runId, status: r.status } };
    },
  });

  // ---- shared blackboard ----
  pi.registerTool({
    name: "notes_read",
    label: "Read notes",
    description: "Read the shared notes blackboard (findings appended by the parent and sibling subagents in this run).",
    parameters: Type.Object({}),
    async execute() {
      const notes = await call<{ author: string; ts: number; text: string }[]>("bridge.notesRead", {});
      return text(notes.length ? notes.map((n) => `[${n.author}] ${n.text}`).join("\n") : "(no notes yet)");
    },
  });
  pi.registerTool({
    name: "notes_append",
    label: "Append note",
    description: "Append a short factual note to the shared blackboard so sibling subagents and the parent can see it. Append-only.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      await call("bridge.notesAppend", params);
      return text("noted");
    },
  });

  // ---- agent ↔ terminal (read-only) ----
  pi.registerTool({
    name: "terminal_read",
    label: "Read terminal",
    description:
      "Read the last lines of a terminal running in the GUI (e.g. Metro bundler, dev server, test watcher) to see errors without the user pasting logs. Read-only.",
    promptSnippet: "Read recent output of a GUI terminal (e.g. Metro) by name",
    parameters: Type.Object({
      name: Type.String({ description: 'Terminal name, e.g. "Metro"' }),
      lines: Type.Optional(Type.Number({ description: "How many lines (default 100, max 2000)" })),
    }),
    async execute(_id, params) {
      const r = await call<{ name: string; status: string; exitCode?: number | null; lines: string[] }>("bridge.terminalRead", params);
      return text(`Terminal "${r.name}" (${r.status}${r.exitCode != null ? `, exit ${r.exitCode}` : ""}) — last ${r.lines.length} lines:\n${r.lines.join("\n")}`);
    },
  });

  // ---- MCP servers (the GUI server is the MCP client; we only expose its tools) ----
  interface McpTool {
    name: string;
    server: string;
    tool: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }
  const mcpSigs = new Map<string, string>();
  let mcpOn = new Set<string>();
  let mcpInstructions: string[] = [];
  let syncing: Promise<void> | undefined;

  const syncMcp = (waitMs: number) =>
    (syncing ??= (async () => {
      try {
        const r = await call<{ tools: McpTool[]; instructions: string[] }>("bridge.mcpTools", { waitMs });
        mcpInstructions = r.instructions;
        const want = new Set<string>();
        for (const t of r.tools) {
          want.add(t.name);
          const sig = JSON.stringify([t.description, t.inputSchema]);
          if (mcpSigs.get(t.name) === sig) continue;
          mcpSigs.set(t.name, sig);
          pi.registerTool(mcpTool(t));
        }
        // registering activates a tool; tools whose server went away/was disabled get deactivated
        const active = new Set(pi.getActiveTools());
        let dirty = false;
        for (const n of mcpOn) if (!want.has(n) && active.delete(n)) dirty = true;
        for (const n of want) if (!mcpOn.has(n) && !active.has(n)) (active.add(n), (dirty = true));
        mcpOn = want;
        if (dirty) pi.setActiveTools([...active]);
      } catch {
        /* GUI unreachable or MCP misconfigured: keep whatever we had */
      } finally {
        syncing = undefined;
      }
    })());

  function mcpTool(t: McpTool) {
    return {
      name: t.name,
      label: `${t.server} · ${t.tool}`,
      description: `[MCP server "${t.server}"] ${t.description || t.tool}`.slice(0, 4000),
      parameters: toolSchema(t.inputSchema) as unknown as ReturnType<typeof Type.Object>,
      async execute(_id: string, params: unknown, signal?: AbortSignal) {
        const r = await call<{ content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError: boolean }>(
          "bridge.mcpCall",
          { server: t.server, tool: t.tool, args: params },
          signal,
        );
        if (r.isError) throw new Error(r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") || `${t.tool} failed`);
        return { content: r.content, details: { mcpServer: t.server, mcpTool: t.tool } };
      },
    };
  }

  void syncMcp(0); // starts the servers in the background; the first prompt waits for them (bounded)
  pi.on("before_agent_start", async (event) => {
    await syncMcp(8000);
    if (!mcpInstructions.length) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n# MCP servers\nInstructions from connected MCP servers (their tools are named mcp__<server>__<tool>):\n${mcpInstructions.join("\n")}` };
  });

  // ---- mid-run channels (subagents only) ----
  if (isSubagent) {
    pi.registerTool({
      name: "message_parent",
      label: "Message parent",
      description: "Send a short progress update to the parent (shown live in the GUI and appended to your report).",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_id, params) {
        await call("bridge.messageParent", params);
        return text("sent");
      },
    });
    pi.registerTool({
      name: "ask_parent",
      label: "Ask parent",
      description: "Ask a blocking question when you cannot proceed without a decision. A human answers in the GUI. Use sparingly.",
      parameters: Type.Object({ question: Type.String() }),
      async execute(_id, params, signal) {
        const answer = await call<string>("bridge.ask", params, signal);
        return text(`Answer: ${answer}`);
      },
    });
  }
}

/** MCP input schemas are plain JSON Schema; pi validates with TypeBox's compiler, which rejects a few things some servers emit. */
function toolSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = { ...(raw && typeof raw === "object" ? raw : {}) };
  delete s.$schema;
  if (s.type !== "object") Object.assign(s, { type: "object" });
  if (!s.properties) s.properties = {};
  for (const cand of [s, stripFormats(s)]) {
    try {
      Compile(cand as never);
      return cand;
    } catch {
      /* try the next, looser one */
    }
  }
  return { type: "object", properties: {}, additionalProperties: true, description: "Arguments as described by the tool" };
}
function stripFormats(v: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v), (k, x) => (k === "format" || k === "$id" ? undefined : x));
}
