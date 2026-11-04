// MCP server status per project, kept fresh by the server's `mcp_changed` events.
import { useEffect } from "react";
import { create } from "zustand";
import type { McpServerInfo } from "@pi-gui/protocol";
import { conn } from "./ws.ts";
import { req } from "./store.ts";

interface McpState {
  byRoot: Record<string, { servers: McpServerInfo[]; errors: string[] }>;
}
export const useMcp = create<McpState>(() => ({ byRoot: {} }));

const keyOf = (project?: string) => project ?? "";
const inflight = new Map<string, Promise<void>>();

export function refreshMcp(project?: string): Promise<void> {
  const k = keyOf(project);
  let p = inflight.get(k);
  if (!p) {
    p = req<{ servers: McpServerInfo[]; errors: string[] }>("mcp.list", { project })
      .then((r) => useMcp.setState((s) => ({ byRoot: { ...s.byRoot, [k]: r } })))
      .catch(() => {})
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Subscribe the focused project to MCP status changes. */
export function useMcpSync(project?: string) {
  useEffect(() => {
    void refreshMcp(project);
    const off = conn.sub("app", (e) => {
      if (e.kind !== "mcp_changed") return; // cheap call — refresh on any change (a global file edit affects every project)
      clearTimeout(timer);
      timer = setTimeout(() => void refreshMcp(project), 150);
    });
    return off;
  }, [project]);
}

export function useMcpSummary(project?: string) {
  const info = useMcp((s) => s.byRoot[keyOf(project)]);
  const servers = info?.servers ?? [];
  return {
    total: servers.filter((s) => s.status !== "disabled").length,
    connected: servers.filter((s) => s.status === "connected").length,
    failing: servers.filter((s) => s.status === "error").length,
    tools: servers.reduce((n, s) => n + (s.status === "connected" ? s.tools.filter((t) => t.enabled !== false).length : 0), 0),
  };
}
