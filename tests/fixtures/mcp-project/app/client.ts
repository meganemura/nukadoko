import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// A minimal MCP client and two transports with the structural shape an
// MCP SDK transport has (`start`, `send`, `close`, `onmessage`,
// `onclose`), so the tests pass them through measureMcp the way a project
// passes the SDK's own. It speaks only what the fixture servers answer:
// JSON over HTTP, and one JSON-RPC message per line over stdio.

type Message = { readonly jsonrpc: "2.0"; readonly id?: number; readonly method?: string; readonly params?: object; readonly result?: any; readonly error?: any };

export interface Transport {
  start(): Promise<void>;
  send(message: Message): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Message) => void;
  onclose?: () => void;
}

/** POSTs each message to `url` and hands the JSON answer back. */
export function httpTransport(url: string): Transport {
  const transport: Transport = {
    async start() {},
    async send(message) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(message) });
      const text = await response.text();
      if (text !== "") transport.onmessage?.(JSON.parse(text) as Message);
    },
    async close() {
      transport.onclose?.();
    },
  };
  return transport;
}

/** Runs `node <script>`, a path relative to this file, and speaks one
 * message per line with it. The process closing closes the transport. */
export function stdioTransport(script: string, env: Record<string, string>): Transport & { readonly pid: () => number | undefined } {
  let child: ReturnType<typeof spawn> | undefined;
  const transport = {
    pid: () => child?.pid,
    async start() {
      child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
      child.on("close", () => transport.onclose?.());
      createInterface({ input: child.stdout! }).on("line", (line) => transport.onmessage?.(JSON.parse(line) as Message));
    },
    async send(message: Message) {
      child!.stdin!.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      child?.kill();
    },
    onmessage: undefined as ((message: Message) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
  };
  return transport;
}

/** Sends requests over `transport` and resolves each with its answer. */
export class Client {
  private next = 1;
  private readonly waiting = new Map<number, (message: Message) => void>();
  private transport: Transport | undefined;

  async connect(transport: Transport): Promise<void> {
    this.transport = transport;
    transport.onmessage = (message) => {
      if (message.id !== undefined) this.waiting.get(message.id)?.(message);
    };
    // A request the server can no longer answer fails, rather than waits.
    transport.onclose = () => {
      for (const resolve of this.waiting.values()) resolve({ jsonrpc: "2.0", error: { code: -32000, message: "Connection closed" } });
      this.waiting.clear();
    };
    await transport.start();
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1.0.0" } });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  request(method: string, params: object): Promise<Message> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, resolve);
      this.transport!.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
    });
  }

  async callTool(name: string, args: object): Promise<Message> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }
}
