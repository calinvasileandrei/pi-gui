import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { Bus } from "./bus.ts";
import { startServer, type OpHandler } from "./http.ts";
import { sessionOps } from "./ops/sessions.ts";
import { Supervisor } from "./sessions.ts";
import { GUI_DIR, loadSettings, saveSettings } from "./settings.ts";
import { isAbsolute } from "node:path";
import { GuiSettingsSchema } from "@pi-gui/protocol";
import { ChangeTracker } from "./changes.ts";
import { RunManager } from "./runs.ts";
import { loadAgents } from "./agents.ts";
import { listExtensions } from "./extensions.ts";
import { terminalOps } from "./ops/terminals.ts";
import { featureOps } from "./ops/features.ts";
import { projectOps } from "./ops/project.ts";
import { mcpOps } from "./ops/mcp.ts";
import { worktreeOps } from "./ops/worktrees.ts";
import { join } from "node:path";
import { defaultPiCommand } from "./pi/adapter.ts";
import { rememberClaudeSession } from "./stored-sessions.ts";
import { PtyManager, ptyLoadError } from "./terminals/pty.ts";

export interface AppOptions {
  /** 0 = pick a free port */
  port?: number;
  token?: string;
  /** directory with the built UI; omit when a dev server (Vite) serves it */
  staticDir?: string;
  /** extra browser origins allowed to connect (Vite dev server) */
  extraOrigins?: string[];
  /** env added to every pi child (e.g. ELECTRON_RUN_AS_NODE) */
  piEnv?: Record<string, string>;
  /** path of the gui-bridge extension (packages/pi-extension/src/index.ts, or a copy inside the app) */
  bridgePath?: string;
  log?: (msg: string) => void;
}

export interface RunningApp {
  url: string;
  port: number;
  token: string;
  piCommand: string[];
  settingsError?: string;
  /** graceful: stop sessions + terminals, close server */
  stop(): Promise<void>;
  /** synchronous hard kill of every child (process 'exit' handler) */
  killAll(): void;
}

/** The whole backend, embeddable: used by the CLI (`main.ts`) and the Electron main process. */
export async function startApp(o: AppOptions = {}): Promise<RunningApp> {
  const log = o.log ?? ((m: string) => console.log(m));
  const { settings, error: settingsError } = await loadSettings();
  const port = o.port ?? settings.port;
  const token = o.token ?? randomBytes(24).toString("base64url");

  const bus = new Bus();
  const ptys = new PtyManager(bus);
  if (!ptys.pty) log(`node-pty unavailable, terminals fall back to plain pipes: ${ptyLoadError}`);
  const piCommand = process.env.PI_GUI_PI_BIN
    ? process.env.PI_GUI_PI_BIN.split(" ").filter(Boolean)
    : settings.piBin
      ? settings.piBin.split(" ")
      : defaultPiCommand(GUI_DIR);

  let baseUrl = "";
  let changes: ChangeTracker;
  const bridgePath = o.bridgePath && existsSync(o.bridgePath) ? o.bridgePath : undefined;
  if (!bridgePath) log("gui-bridge extension not found — subagents, terminal_read and edit snapshots are disabled");
  const sup = new Supervisor({
    bus,
    piCommand,
    restartOnCrash: settings.restartOnCrash,
    baseEnv: () => ({ ...o.piEnv, PI_GUI_URL: baseUrl, PI_GUI_TOKEN: token }),
    baseArgs: () => (bridgePath ? ["-e", bridgePath] : []),
    onRemoved: (id) => changes.dropSession(id),
    claudeBin: () => settings.claudeBin,
    onClaudeSession: (file) => {
      void rememberClaudeSession(file);
      bus.publish("app", { kind: "stored_changed" });
    },
  });
  sup.registerKiller(() => ptys.killAll());
  changes = new ChangeTracker(
    (sessionId, path) => bus.publish(`session:${sessionId}`, { kind: "changes_dirty", sessionId, path }),
    (request) => bus.publish(`session:${request.sessionId}`, { kind: "approval", request }),
    (id) => bus.publish("app", { kind: "approval_done", id }),
  );
  const mcp = mcpOps({ sup, bus });
  const runs = new RunManager(sup, bus, {
    concurrency: settings.subagentConcurrency,
    maxDepth: settings.subagentMaxDepth,
    loadAgents: (project) => loadAgents(project),
    mcpTools: async (project) => (await mcp.mcp.toolsFor(project)).tools.map((t) => t.name),
    resolveExtension: async (nameOrPath, project) => {
      if (isAbsolute(nameOrPath)) return existsSync(nameOrPath) ? nameOrPath : undefined;
      return (await listExtensions(project)).find((e) => e.name === nameOrPath && e.source !== "package")?.path;
    },
  });
  const term = terminalOps(ptys, bus);
  const features = featureOps({ sup, changes, runs, ptys, guiDir: GUI_DIR, bridgePath: bridgePath ?? "" });
  const project = projectOps({ sup, bus, changes, guiDir: GUI_DIR });
  const wt = worktreeOps({ sup, ptys, bus, prefsFile: join(GUI_DIR, "worktrees.json") });

  const ops: Record<string, OpHandler> = {
    "app.hello": () => ({
      sessions: sup.list(),
      terminals: ptys.list(),
      settings,
      settingsError,
      cwd: process.env.HOME ?? process.cwd(),
      piCommand,
      pty: !!ptys.pty,
      bridge: !!bridgePath,
    }),
    "settings.get": () => settings,
    "settings.save": async (a) => {
      const next = GuiSettingsSchema.parse({ ...settings, ...(a as object) });
      Object.assign(settings, next);
      runs.setConcurrency(settings.subagentConcurrency);
      await saveSettings(settings);
      return settings;
    },
    ...sessionOps(sup, bus, { harness: () => settings.defaultHarness }),
    ...term.ops,
    ...features.ops,
    ...project.ops,
    ...mcp.ops,
    ...wt.ops,
  };

  const srv = await startServer({
    host: "127.0.0.1",
    port,
    token,
    bus,
    ops,
    httpOps: new Set([...features.httpOps, ...mcp.httpOps]), // only what the gui-bridge extension needs
    ptyInput: (id, data) => ptys.terminals.get(id)?.write(data),
    ptyResize: (id, c, r) => ptys.terminals.get(id)?.resize(c, r),
    staticDir: o.staticDir && existsSync(o.staticDir) ? o.staticDir : undefined,
    extraOrigins: o.extraOrigins,
  });
  baseUrl = srv.url;

  let stopping: Promise<void> | undefined;
  return {
    url: srv.url,
    port: srv.port,
    token,
    piCommand,
    settingsError,
    killAll: () => sup.killAll(),
    stop: () =>
      (stopping ??= (async () => {
        const hard = setTimeout(() => sup.killAll(), 4000);
        await Promise.allSettled([sup.stopAll(), ptys.stopAll(), term.close(), project.close(), mcp.close()]);
        await srv.close();
        clearTimeout(hard);
      })()),
  };
}
