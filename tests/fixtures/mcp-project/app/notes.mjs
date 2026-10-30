import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// What both servers share: the notes tool and the writer of execution
// events (docs/execution-events.md), one JSON object per line, appended in
// one write call. A note is held in memory; its insert is the line.
const EVENTS = process.env.EXECUTION_EVENTS;

export const newId = () => randomBytes(8).toString("hex");

export function emit(fields) {
  if (EVENTS !== undefined) appendFileSync(EVENTS, `${JSON.stringify(fields)}\n`);
}

const notes = [];

/** Adds `text` as a note under `trace`, or refuses an empty one with
 * `isError` and writes nothing. */
export function addNote(text, trace) {
  if (typeof text !== "string" || text === "") return { content: [{ type: "text", text: "a note needs text" }], isError: true };
  notes.push(text);
  emit({ trace, kind: "db", id: newId(), table: "notes", op: "insert", rows: 1, ids: [notes.length], committed: true });
  return { content: [{ type: "text", text: `note ${notes.length}` }], structuredContent: { id: notes.length } };
}

/** The answer to one JSON-RPC message, or `undefined` for a
 * notification. `add` adds a note for a `tools/call` of `add_note`. */
export async function answer(message, add) {
  const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1.0.0" } });
    case "tools/call":
      if (message.params.name === "add_note") return reply(await add(message.params.arguments ?? {}));
      return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${message.params.name}` } };
    default:
      return message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
}
