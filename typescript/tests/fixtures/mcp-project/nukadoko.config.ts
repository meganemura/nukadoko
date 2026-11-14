import { fileURLToPath } from "node:url";
import { Client as SdkClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, httpTransport, stdioTransport } from "./app/client.js";
import { defineConfig, measureMcp } from "./nukadoko-shim.js";

// MCP clients, each connected in a scenario fixture, outside every step,
// and called from steps: to the world over HTTP, and to a stdio server
// that calls the world. The first two are a hand-written client; the
// `sdk` pair is the official SDK client with its own transports, so the
// wrapper is proved on what a project passes it.
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
    sdkOverHttp: async ({ baseURL }, use) => {
      const client = new SdkClient({ name: "fixture", version: "1.0.0" });
      await client.connect(measureMcp(new StreamableHTTPClientTransport(new URL("/mcp", baseURL))));
      await use(client);
      await client.close();
    },
    sdkOverStdio: async ({ baseURL }, use) => {
      const client = new SdkClient({ name: "fixture", version: "1.0.0" });
      const server = fileURLToPath(new URL("./app/stdio.mjs", import.meta.url));
      await client.connect(measureMcp(new StdioClientTransport({ command: process.execPath, args: [server], env: { PATH: process.env.PATH ?? "", WORLD_URL: baseURL! } })));
      await use(client);
      await client.close();
    },
  },
});
