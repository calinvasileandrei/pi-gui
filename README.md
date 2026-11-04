# pi GUI

A macOS desktop app (Electron) for the [pi coding agent](https://github.com/badlogic/pi-mono). It works with any provider pi supports.

- Chat sessions grouped by project, with tool cards, edit approvals and context usage.
- A file tree and a Git panel that are always visible, plus editor and diff tabs.
- Subagents, terminals, extensions and MCP servers.

## Install

Download `pi-gui-<version>-mac-arm64.zip` from [Releases](../../releases), unzip it, and move `pi.app` to Applications.

The build is not signed. The first time you open it, right-click the app and choose **Open**, or run:

```sh
xattr -dr com.apple.quarantine /Applications/pi.app
```

You need [pi](https://github.com/badlogic/pi-mono) installed, logged in to at least one provider (`pi` → `/login`).

## Develop

```sh
pnpm install
pnpm dev:desktop     # Electron + Vite with hot reload
pnpm test            # vitest
pnpm typecheck
pnpm --filter @pi-gui/desktop package   # builds out/release/mac-arm64/pi.app
```

Packages: `server` (backend that runs pi over RPC), `ui` (React), `desktop` (Electron shell), `pi-extension` (the gui-bridge extension loaded into pi), `protocol` (shared types).
