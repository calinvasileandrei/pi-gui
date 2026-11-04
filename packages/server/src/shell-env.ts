import { spawn } from "node:child_process";

/**
 * Apps launched from Finder/Dock get launchd's minimal env (PATH=/usr/bin:/bin:…): no nvm,
 * no Homebrew, nothing from .zshrc. Like VS Code, ask the user's login+interactive shell for
 * its environment once at startup and merge it in, so pi's bash tool and terminals behave
 * exactly as in Terminal.app.
 */
export async function resolveShellEnv(timeoutMs = 10_000): Promise<Record<string, string> | null> {
  if (process.platform === "win32") return null;
  const shell = process.env.SHELL || "/bin/zsh";
  const mark = `__PI_GUI_ENV_${Math.random().toString(36).slice(2)}__`;
  return new Promise((resolve) => {
    const child = spawn(shell, ["-l", "-i", "-c", `printf '${mark}'; command env -0; printf '${mark}'`], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PI_GUI_RESOLVING_SHELL_ENV: "1" },
      detached: true, // own session: an interactive shell must not grab our (non-existent) tty
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
      resolve(null);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      const a = out.indexOf(mark);
      const b = out.lastIndexOf(mark);
      if (a < 0 || b <= a) return resolve(null);
      const env: Record<string, string> = {};
      for (const kv of out.slice(a + mark.length, b).split("\0")) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      resolve(env);
    });
  });
}

/** Merge a resolved shell env into process.env, keeping our own / Electron's runtime variables. */
export function applyShellEnv(env: Record<string, string>): void {
  const keep = new Set(["ELECTRON_RUN_AS_NODE", "PI_GUI_RESOLVING_SHELL_ENV", "_", "SHLVL", "PWD", "OLDPWD"]);
  for (const [k, v] of Object.entries(env)) {
    if (keep.has(k) || k.startsWith("ELECTRON_") || k.startsWith("PI_GUI_")) continue;
    process.env[k] = v;
  }
}
