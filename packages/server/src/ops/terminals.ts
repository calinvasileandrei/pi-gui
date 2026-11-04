import { watch, type FSWatcher } from "chokidar";
import { z } from "zod";
import { TerminalProfileSchema } from "@pi-gui/protocol";
import type { OpHandler } from "../http.ts";
import type { Bus } from "../bus.ts";
import type { PtyManager } from "../terminals/pty.ts";
import { checkDir, deleteProfile, globalTerminalsFile, loadProfiles, projectTerminalsFile, resolveCwd, saveProfile } from "../terminals/profiles.ts";
import { killPort, portHolders } from "../terminals/ports.ts";
import { expandHome } from "./sessions.ts";
import { resolve } from "node:path";

const Proj = z.object({ project: z.string() });
const proj = (p: string) => resolve(expandHome(p));

export function terminalOps(ptys: PtyManager, bus: Bus) {
  const autostarted = new Set<string>();
  const watchers = new Map<string, FSWatcher>();

  /** hot-reload: re-publish profiles when either terminals.json changes */
  function watchProject(project: string) {
    if (watchers.has(project)) return;
    const w = watch([projectTerminalsFile(project), globalTerminalsFile()], { ignoreInitial: true });
    const fire = async () => {
      const { profiles, errors } = await loadProfiles(project);
      bus.publish("app", { kind: "toast", level: errors.length ? "error" : "info", message: errors.length ? `terminals.json: ${errors[0]!.message}` : "Terminal profiles reloaded" });
      bus.publish("app", { kind: "profiles", project, profiles, errors });
    };
    w.on("add", fire).on("change", fire).on("unlink", fire);
    watchers.set(project, w);
  }

  const ops: Record<string, OpHandler> = {
    "terminal.list": () => ptys.list(),

    /** profiles for a project (merged global + project), plus their live state. Runs autostart once. */
    "terminal.profiles": async (a) => {
      const project = proj(Proj.parse(a).project);
      watchProject(project);
      const { profiles, errors } = await loadProfiles(project);
      for (const p of profiles) {
        if (p.autostart && !autostarted.has(p.id) && !p.cwdError) {
          autostarted.add(p.id);
          ptys.open({ id: p.id, name: p.name, cwd: p.resolvedCwd, command: p.command, env: p.env, port: p.port, profile: true, project, restartOnExit: p.restartOnExit });
        }
      }
      return { profiles, errors };
    },

    "terminal.start": async (a) => {
      const { project: rawProject, name } = z.object({ project: z.string(), name: z.string() }).parse(a);
      const project = proj(rawProject);
      const { profiles } = await loadProfiles(project);
      const p = profiles.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!p) throw new Error(`no terminal profile named "${name}"`);
      if (p.cwdError) throw new Error(p.cwdError);
      if (p.port) {
        const holders = await portHolders(p.port);
        const running = ptys.terminals.get(p.id);
        if (holders.length && running?.status !== "running")
          return { portBusy: { port: p.port, holders } }; // UI offers "kill holder & start"
      }
      return ptys.open({ id: p.id, name: p.name, cwd: p.resolvedCwd, command: p.command, env: p.env, port: p.port, profile: true, project, restartOnExit: p.restartOnExit }).info();
    },

    /** unsaved one-off command, or a plain interactive shell when command is empty */
    "terminal.runOnce": async (a) => {
      const { project: rawProject, command, cwd } = z.object({ project: z.string(), command: z.string().default(""), cwd: z.string().optional() }).parse(a);
      const project = proj(rawProject);
      const dir = resolveCwd(cwd || ".", project);
      const err = checkDir(dir);
      if (err) throw new Error(err);
      const name = command.trim() ? command.trim().split(/\s+/).slice(0, 3).join(" ") : "shell";
      return ptys.open({ name, cwd: dir, command: command.trim() || undefined, profile: false, project }).info();
    },

    "terminal.stop": async (a) => {
      await ptys.get(z.object({ id: z.string() }).parse(a).id).stop();
    },
    "terminal.restart": async (a) => {
      const t = ptys.get(z.object({ id: z.string() }).parse(a).id);
      await t.restart();
      return t.info();
    },
    "terminal.close": async (a) => {
      await ptys.remove(z.object({ id: z.string() }).parse(a).id);
    },

    "terminal.saveProfile": async (a) => {
      const { project, scope, profile, previousName } = z
        .object({ project: z.string(), scope: z.enum(["project", "global"]), profile: TerminalProfileSchema, previousName: z.string().optional() })
        .parse(a);
      await saveProfile(proj(project), scope, profile, previousName);
      return loadProfiles(proj(project));
    },
    "terminal.deleteProfile": async (a) => {
      const { project, scope, name } = z.object({ project: z.string(), scope: z.enum(["project", "global"]), name: z.string() }).parse(a);
      await deleteProfile(proj(project), scope, name);
      return loadProfiles(proj(project));
    },
    "terminal.checkDir": (a) => {
      const { project, cwd } = z.object({ project: z.string(), cwd: z.string() }).parse(a);
      const dir = resolveCwd(cwd, proj(project));
      return { resolved: dir, error: checkDir(dir) };
    },

    "terminal.portCheck": async (a) => ({ holders: await portHolders(z.object({ port: z.number().int() }).parse(a).port) }),
    "terminal.killPort": async (a) => ({ killed: await killPort(z.object({ port: z.number().int() }).parse(a).port) }),

    /** read-only tail of a terminal by name or id (backs the agent's terminal_read tool) */
    "terminal.read": (a) => {
      const { name, id, lines } = z.object({ name: z.string().optional(), id: z.string().optional(), lines: z.number().int().min(1).max(2000).default(100) }).parse(a);
      const t = id ? ptys.terminals.get(id) : name ? ptys.findByName(name) : undefined;
      if (!t) {
        const available = ptys.list().map((x) => `${x.name} (${x.status})`);
        throw new Error(`no terminal "${name ?? id}". Available: ${available.join(", ") || "none"}`);
      }
      return { name: t.spec.name, status: t.status, exitCode: t.exitCode, lines: t.readLines(lines) };
    },
  };
  return { ops, close: () => Promise.all([...watchers.values()].map((w) => w.close())) };
}
