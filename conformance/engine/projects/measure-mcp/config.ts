import { defineConfig, defineFixtures, measureMcp } from "nukadoko";

type Message = { id?: number; method?: string; params?: unknown };

// A transport in the shape every MCP SDK client is built on: send posts
// one message, and an answer comes back through onmessage.
function notesTransport(url: string) {
  return {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    async start() {},
    async close() {
      this.onclose?.();
    },
    async send(message: Message) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
      const text = await response.text();
      if (text !== "") this.onmessage?.(JSON.parse(text));
    },
  };
}

// A transport that answers in the process, as a stdio server's would:
// nothing goes to the world.
function localTransport() {
  return {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    async start() {},
    async close() {},
    async send(message: Message) {
      this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "local" }] } });
    },
  };
}

// The least a client does: number its requests, send them, and wait for
// each answer by its id.
function client(transport: ReturnType<typeof notesTransport>) {
  let next = 0;
  const waiting = new Map<unknown, (answer: unknown) => void>();
  transport.onmessage = (message) => {
    const id = (message as Message).id;
    waiting.get(id)?.(message);
    waiting.delete(id);
  };
  return {
    async call(method: string, params?: unknown) {
      next += 1;
      const answer = new Promise((resolve) => waiting.set(next, resolve));
      await transport.send({ jsonrpc: "2.0", id: next, method, ...(params === undefined ? {} : { params }) } as Message);
      return answer;
    },
    async notify(method: string) {
      await transport.send({ jsonrpc: "2.0", method } as Message);
    },
  };
}

export type NotesClient = ReturnType<typeof client>;

export default defineConfig({
  fixtures: defineFixtures({
    notes: async ({ baseURL }, use) => {
      await use(client(measureMcp(notesTransport(new URL("/mcp", baseURL).href))));
    },
    local_notes: async ({}, use) => {
      await use(client(measureMcp(localTransport())));
    },
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    notes: NotesClient;
    local_notes: NotesClient;
  }
}
