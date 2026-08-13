import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcpServer } from "./nukadoko-mcp-shim.js";
import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// The server calls-mcp-tool-step.ts reaches is
// tests/helpers/mcp-test-server.ts, this repo's own test-only MCP server,
// run via tsx the same way tests/cli.test.ts already spawns the real `nuka`
// CLI as a subprocess. Its command and args are ordinary fixture setup, not
// a nukadoko.config.ts key: an MCP server's process lifetime rides on the
// existing fixture mechanism (setup, teardown, scope), the same as any
// other resource a fixture owns (docs/spec.md "MCP servers") — this file
// states the launch command exactly as any real project's own fixture
// would state its own server's.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const serverScript = path.join(repoRoot, "tests", "helpers", "mcp-test-server.ts");

export default defineConfig({
  fixtures: defineFixtures({
    mcpClient: async ({}, use) => {
      const client = await connectMcpServer({ command: tsxBin, args: [serverScript] });
      await use(client);
      await client.close();
    },
  }),
});
