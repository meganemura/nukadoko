import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// The writer both processes share: one JSON object per line, appended in
// one write call, as docs/execution-events.md "Where lines go" asks.
const EVENTS = process.env.EXECUTION_EVENTS;

export const newId = () => randomBytes(8).toString("hex");

export function emit(fields) {
  if (EVENTS === undefined) return;
  appendFileSync(EVENTS, `${JSON.stringify(fields)}\n`);
}

/** Writes `text` as it is, with no line end of its own: a writer that
 * splits one line across two writes. */
export function emitRaw(text) {
  if (EVENTS !== undefined) appendFileSync(EVENTS, text);
}
