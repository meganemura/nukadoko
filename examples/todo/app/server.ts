import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

// The one thing this example app exists to demonstrate: an in-memory todo
// API whose text field is called "title" in v1 and renamed to "name" in
// v2 -- nothing else about the API changes. That single rename is enough to
// break any typed step written against v1 the moment the app moves to v2,
// which is the whole point (see examples/todo/README.md, Part 2). No
// framework, no dependency beyond node:http -- this app is scaffolding for
// the walkthrough, not a thing worth designing well.

export interface TodoAppOptions {
  /** Switches the API's text field from "title" (v1, default) to "name" (v2). */
  v2?: boolean;
}

type TodoRecord = Record<string, unknown>;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    // Malformed JSON is treated as an empty body rather than a 400: this
    // app's only job is to model the field rename, not to be a robust API.
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Builds the todo API as an unstarted node:http server; call `.listen()`. */
export function createTodoApp(options: TodoAppOptions = {}): ReturnType<typeof createServer> {
  const fieldName = options.v2 ? "name" : "title";
  const todos: TodoRecord[] = [];

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

    if (req.method === "POST" && segments.length === 1 && segments[0] === "todos") {
      const body = await readJsonBody(req);
      // Deliberately lenient: if the caller sends the *other* version's
      // field name, this simply stores `undefined` under the field this
      // version actually uses -- a silent shape drift, not a loud error,
      // because that is how the field rename actually breaks a v1 step
      // (docs/spec.md "Self-healing, audited": "the app changed, the
      // pattern no longer matches reality").
      const record: TodoRecord = { id: randomUUID(), [fieldName]: body[fieldName], done: false };
      todos.push(record);
      send(res, 201, record);
      return;
    }

    if (req.method === "GET" && segments.length === 1 && segments[0] === "todos") {
      send(res, 200, todos);
      return;
    }

    if (req.method === "GET" && segments.length === 2 && segments[0] === "todos") {
      const record = todos.find((todo) => todo.id === segments[1]);
      if (!record) {
        send(res, 404, { error: "not found" });
        return;
      }
      send(res, 200, record);
      return;
    }

    if (req.method === "PATCH" && segments.length === 2 && segments[0] === "todos") {
      const record = todos.find((todo) => todo.id === segments[1]);
      if (!record) {
        send(res, 404, { error: "not found" });
        return;
      }
      const body = await readJsonBody(req);
      if (typeof body.done === "boolean") {
        record.done = body.done;
      }
      send(res, 200, record);
      return;
    }

    send(res, 404, { error: "unknown route" });
  });
}

function parseArgs(argv: readonly string[]): { port: number; v2: boolean } {
  let port = 4000;
  // An env var alongside the flag: the walkthrough's reader types --v2 by
  // hand, the smoke test (tests/examples-todo.test.ts) starts this same app
  // in-process and toggles the option directly -- the flag exists for the
  // human path only, kept here so the two paths stay demonstrably the same
  // code.
  let v2 = process.env.TODO_APP_V2 === "1";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value !== undefined) port = Number(value);
      i++;
    } else if (arg === "--v2") {
      v2 = true;
    }
  }
  return { port, v2 };
}

// Only starts a listening server when this file is run directly (`tsx
// app/server.ts`), never when `createTodoApp` is imported -- the smoke test
// imports it to run the app in-process on an ephemeral port instead.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const { port, v2 } = parseArgs(process.argv.slice(2));
  const server = createTodoApp({ v2 });
  server.listen(port, () => {
    const mode = v2 ? ' (v2: field renamed "title" -> "name")' : "";
    console.log(`todo app listening on http://localhost:${port}${mode}`);
  });
}
