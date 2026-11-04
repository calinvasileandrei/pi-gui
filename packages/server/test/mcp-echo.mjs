// Tiny stdio MCP server for tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const s = new McpServer({ name: "echo-test", version: "1.2.3" }, { instructions: "Use echo to repeat text." });
s.registerTool("echo", { description: "Repeat text", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
s.registerTool("whereami", { description: "cwd and FOO", inputSchema: {} }, async () => ({ content: [{ type: "text", text: `${process.cwd()}|${process.env.FOO ?? ""}|${process.env.PI_GUI_TOKEN ?? "no-token"}` }] }));
s.registerTool("boom", { description: "Always fails", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "it broke" }] }));
console.error("echo-test server starting");
await s.connect(new StdioServerTransport());
