// Builds out/release/mac-arm64/pi.app  (ad-hoc signed)
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("pnpm", ["--filter", "@pi-gui/ui", "build"]);
run("node", ["build.mjs"], join(root, "packages/desktop"));

const deploy = join(root, "out/deploy");
rmSync(deploy, { recursive: true, force: true });
rmSync(join(root, "out/release"), { recursive: true, force: true });
run("pnpm", ["--filter", "@pi-gui/desktop", "deploy", "--prod", deploy]);

// node-pty's prebuilt spawn-helper ships without +x; the installed .app may be read-only, so fix it now.
for (const d of readdirSync(join(deploy, "node_modules/node-pty/prebuilds"))) {
  const h = join(deploy, "node_modules/node-pty/prebuilds", d, "spawn-helper");
  if (existsSync(h)) chmodSync(h, statSync(h).mode | 0o755);
}
// drop non-mac prebuilds to save space
for (const d of readdirSync(join(deploy, "node_modules/node-pty/prebuilds")))
  if (!d.startsWith("darwin")) rmSync(join(deploy, "node_modules/node-pty/prebuilds", d), { recursive: true, force: true });

run(join(root, "packages/desktop/node_modules/.bin/electron-builder"), ["--mac", "dir", "--arm64", "--config", "electron-builder.yml"], join(root, "packages/desktop"));

const app = join(root, "out/release/mac-arm64/pi.app");
// ad-hoc signature: required for arm64 binaries to launch after electron-builder modified the bundle
run("codesign", ["--force", "--deep", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
console.log(`\nbuilt ${app}`);
