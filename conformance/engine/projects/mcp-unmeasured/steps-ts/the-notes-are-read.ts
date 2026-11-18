import { defineStep, z } from "nukadoko";

// An MCP client connected to a transport built inside the connect call:
// nothing can wrap that transport in measureMcp. `nuka check` only reads
// this, so the SDK is declared rather than installed.
declare const Client: new (info: { name: string; version: string }) => { connect(transport: unknown): Promise<void> };
declare const StdioClientTransport: new (options: { command: string }) => unknown;

export default defineStep({
  description: "Read the notes over MCP from a server the step starts",
  pattern: "the notes are read",
  args: z.object({}),
  mutates: false,
  async run() {
    const client = new Client({ name: "acceptance", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "notes-server" }));
  },
});
