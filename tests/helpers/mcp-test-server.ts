import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Responsibility: a real MCP server over stdio, for tests/mcp-client.test.ts
// and tests/fixtures/mcp-tools-project's own `mcpClient` fixture to spawn
// as a genuine subprocess (via tsx, the same way tests/cli.test.ts already
// spawns the real `nuka` CLI as a subprocess) and connect to — the actual
// server half of the protocol, not a mock of the client-facing behavior
// this repo's own src/mcp/* exercises. Two tools: `add`, an ordinary
// successful call, and `always_fails`, which returns MCP's own in-band
// tool-failure shape (`{ isError: true, content: [...] }`) so
// src/mcp/call-tool.ts's own `isError` check has something real to catch.

const server = new McpServer({ name: "nukadoko-test-mcp-server", version: "0.0.0" });

server.registerTool(
  "add",
  {
    description: "Adds two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
  },
  async ({ a, b }) => ({
    content: [{ type: "text" as const, text: String(a + b) }],
  }),
);

server.registerTool(
  "always_fails",
  {
    description: "Always returns an in-band tool failure",
    inputSchema: z.object({}),
  },
  async () => ({
    isError: true,
    content: [{ type: "text" as const, text: "deliberate failure" }],
  }),
);

await server.connect(new StdioServerTransport());
