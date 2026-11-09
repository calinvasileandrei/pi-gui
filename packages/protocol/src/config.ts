import { z } from "zod";

export const TerminalProfileSchema = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1).default("."),
  command: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  port: z.number().int().min(1).max(65535).optional(),
  autostart: z.boolean().default(false),
  restartOnExit: z.boolean().default(false),
});
export type TerminalProfile = z.infer<typeof TerminalProfileSchema>;

export const TerminalsFileSchema = z.object({ terminals: z.array(TerminalProfileSchema).default([]) });

const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean));

export const AgentFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _ only"),
  description: z.string().default(""),
  model: z.string().optional(), // "provider/id" or pattern; any provider
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  tools: csv.optional(),
  extensions: csv.optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSec: z.number().int().positive().optional(),
  canSpawn: z.boolean().default(false),
});
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;
export interface AgentDefinition extends AgentFrontmatter {
  systemPrompt: string;
  scope: "project" | "global";
  file: string;
}

export const GuiSettingsSchema = z.object({
  port: z.number().int().default(4517),
  subagentConcurrency: z.number().int().min(1).max(10).default(2),
  subagentMaxDepth: z.number().int().min(0).max(3).default(1),
  restartOnCrash: z.boolean().default(false),
  piBin: z.string().optional(), // override pi binary
  /** agent for new sessions: pi, or the user's own Claude Code (runs on their Claude plan) */
  defaultHarness: z.enum(["pi", "claude"]).default("pi"),
  /** override the `claude` CLI location */
  claudeBin: z.string().optional(),
  projects: z.array(z.string()).default([]),
});
export type GuiSettings = z.infer<typeof GuiSettingsSchema>;
