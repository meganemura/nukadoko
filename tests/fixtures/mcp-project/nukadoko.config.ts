import { Client, httpTransport, stdioTransport } from "./app/client.js";
import { defineConfig, measureMcp } from "./nukadoko-shim.js";

// Two MCP clients, each connected in a scenario fixture, outside every
// step, and called from steps: one to the world over HTTP, and one to a
// stdio server that calls the world.
export default defineConfig({
  fixtures: {
    notesOverHttp: async ({ baseURL }, use) => {
      const client = new Client();
      await client.connect(measureMcp(httpTransport(new URL("/mcp", baseURL).href)));
      await use(client);
      await client.close();
    },
    notesOverStdio: async ({ baseURL }, use) => {
      const client = new Client();
      await client.connect(measureMcp(stdioTransport("./stdio.mjs", { WORLD_URL: baseURL! })));
      await use(client);
      await client.close();
    },
  },
});
