import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { connectMcpServer } from "./connect.js";

// Responsibility: the "A" half of this pair, `nuka mcp-tools`'s own logic
// (src/cli/mcp-tools.ts is its thin CLI wiring): connect to a server just
// long enough to read the tools it declares, then close it again. Never a
// source of step vocabulary — `nuka steps` never reads this module and
// this module never reads discovery, the same separation
// src/webmcp/list-tools.ts already keeps for the same reason: a server's
// own declared tools are material for a person hand-writing a step's
// `args`, not something that generates a step, or its vocabulary, on its
// own (docs/spec.md "MCP servers", and this project's own reason for that
// rule).
//
// Not re-exported from index.ts: `nukadoko/mcp`'s own published surface is
// `connectMcpServer`/`callMcpTool` (this pair's "B" half), a step's own
// concern; this "connect, list, close" shape is the CLI's alone.

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  /** The server's own JSON Schema, exactly as `Client.listTools()`
   * returned it: not re-serialized, and not translated into a `zod`
   * shape — read by a person hand-writing a step's `args` schema, per this
   * package's own decision not to generate one automatically (docs/spec.md
   * "MCP servers"). */
  readonly inputSchema: unknown;
}

/**
 * Connects to the server `params` describes, reads every tool it declares
 * via one `listTools()` call, and closes the connection before returning —
 * this call's own process never outlives it, unlike a fixture-owned
 * connection built for B (connect.ts's own header).
 */
export async function listMcpTools(params: StdioServerParameters): Promise<McpToolDescriptor[]> {
  const client = await connectMcpServer(params);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  } finally {
    await client.close();
  }
}
