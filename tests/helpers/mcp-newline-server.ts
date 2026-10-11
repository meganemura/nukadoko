import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Responsibility: an MCP server whose descriptions contain newlines, for
// tests/mcp-tools-cli.test.ts to list in text mode. Separate from
// mcp-test-server.ts because that server's tool names are asserted exactly
// by tests/mcp-client.test.ts and by the fixture that calls `add`.

const server = new McpServer({ name: "nukadoko-newline-mcp-server", version: "0.0.0" });

server.registerTool(
  "search",
  {
    description: "Finds records\n\n  across files\nby name",
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
);

server.registerTool(
  "wrapped",
  {
    description: "Keeps\r\na line",
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
);

server.registerTool(
  "tabbed",
  {
    description: "Keeps a tab",
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
);

await server.connect(new StdioServerTransport());
