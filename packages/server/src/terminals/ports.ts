import { execFile } from "node:child_process";
import { createServer } from "node:net";

export interface PortHolder {
  pid: number;
  command: string;
}

/** Who is listening on a TCP port (any address)? Empty array = free. */
export async function portHolders(port: number): Promise<PortHolder[]> {
  if (process.platform === "win32") return (await canBind(port)) ? [] : [{ pid: -1, command: "unknown (Windows)" }];
  const pids = await new Promise<number[]>((resolve) =>
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], (_e, out) =>
      resolve([...new Set(String(out ?? "").split("\n").map((l) => Number(l.trim())).filter((n) => n > 0))]),
    ),
  );
  if (pids.length === 0) return (await canBind(port)) ? [] : [{ pid: -1, command: "unknown process" }];
  return Promise.all(
    pids.map(
      (pid) =>
        new Promise<PortHolder>((resolve) =>
          execFile("ps", ["-o", "command=", "-p", String(pid)], (_e, out) => resolve({ pid, command: String(out ?? "").trim() || "?" })),
        ),
    ),
  );
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}

/** Kill the holders of a port (SIGTERM, then SIGKILL). Never kills ourselves. */
export async function killPort(port: number): Promise<number[]> {
  const holders = (await portHolders(port)).filter((h) => h.pid > 0 && h.pid !== process.pid);
  for (const h of holders) {
    try {
      process.kill(h.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  for (const h of await portHolders(port)) {
    if (h.pid > 0 && h.pid !== process.pid) {
      try {
        process.kill(h.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  return holders.map((h) => h.pid);
}
