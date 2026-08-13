import { z } from "zod";
import { callMcpTool } from "../../nukadoko-mcp-shim.js";
import { defineStep } from "../../nukadoko-shim.js";

// This fixture project's own real step vocabulary, reaching the MCP server
// exclusively through the mcpClient fixture (nukadoko.config.ts) and
// callMcpTool ("nukadoko/mcp") — never page or context, so
// `nuka steps --json`'s needs_browser comes back false for it the same way
// it does for any other fixture that stays off the browser (see
// tests/mcp-client.test.ts's own assertion on this entry).
export default defineStep({
  pattern: "two numbers are added through the MCP server",
  description: "Destructures the mcpClient fixture and calls its add tool",
  args: z.object({ a: z.number(), b: z.number() }),
  returns: z.object({ sum: z.number() }),
  mutates: false,
  async run({ mcpClient }: any, { a, b }) {
    const result = await callMcpTool(mcpClient, "add", { a, b });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    return { sum: Number(content?.[0]?.text) };
  },
});
