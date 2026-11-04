// CLI entry: `pnpm start` / `pnpm dev`. Browser mode. The Electron app embeds startApp() instead.
import { fileURLToPath } from "node:url";
import { startApp } from "./app.ts";

const dev = process.env.PI_GUI_DEV === "1";
const app = await startApp({
  port: process.env.PI_GUI_PORT ? Number(process.env.PI_GUI_PORT) : undefined,
  token: process.env.PI_GUI_TOKEN_OVERRIDE,
  staticDir: fileURLToPath(new URL("../../ui/dist", import.meta.url)),
  bridgePath: fileURLToPath(new URL("../../pi-extension/src/index.ts", import.meta.url)),
  extraOrigins: dev ? ["http://127.0.0.1:5173", "http://localhost:5173"] : [],
});

const uiUrl = dev ? `http://127.0.0.1:5173/#token=${app.token}` : `${app.url}/#token=${app.token}`;
console.log(`\n  pi-gui listening on ${app.url} (loopback only)`);
console.log(`  pi: ${app.piCommand.join(" ")}`);
console.log(`  open: ${uiUrl}\n`);
if (app.settingsError) console.warn(`  settings error (using defaults): ${app.settingsError}`);

let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  await app.stop();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown());
process.on("exit", () => app.killAll()); // last line of defence against orphans
process.on("uncaughtException", (e) => console.error("[uncaught]", e)); // one bad record must not kill every session
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));
