// Bundles the Electron main process (and the embedded server) into dist/main.mjs.
// Native / spawned-by-path packages stay external and are resolved from this package's node_modules.
import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: [
    "electron",
    "node-pty", // native addon
    "@mariozechner/pi-coding-agent", // we only resolve its cli.js path and spawn it
    "bufferutil", // optional native deps of ws
    "utf-8-validate",
  ],
  // bundled CJS deps (ws) call require(); give the ESM bundle one
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
// sandboxed preloads must be CommonJS
await build({ entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "warning" });

// production UI is served by the embedded server from dist/ui
const ui = new URL("../ui/dist", import.meta.url);
rmSync(new URL("dist/ui", import.meta.url), { recursive: true, force: true });
if (existsSync(ui)) cpSync(ui, new URL("dist/ui", import.meta.url), { recursive: true });
else if (process.env.PI_GUI_DEV !== "1") console.warn("warning: packages/ui/dist missing — run `pnpm --filter @pi-gui/ui build`");
// the gui-bridge pi extension ships as a source file (pi loads .ts extensions via jiti)
cpSync(new URL("../pi-extension/src/index.ts", import.meta.url), new URL("dist/gui-bridge.ts", import.meta.url));
console.log("built dist/main.mjs");
