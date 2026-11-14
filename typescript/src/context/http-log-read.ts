import type { HttpVia } from "../record/types.js";
import type { HttpLogEntry } from "./http-log.js";

// Responsibility: the read side of http.jsonl, for the layers above the
// context: each line as the entry the writers built (http-log.ts,
// page-http-log.ts), or `null` for a line that is not one. Boundary: pure;
// reading the file is the caller's. The claim channels (src/run/measured.ts)
// and the failures underneath an execution (src/run/underneath.ts) both
// read the file through this one parser, so a line's index means the same
// to both.

export type { HttpLogEntry } from "./http-log.js";

const VIAS: ReadonlySet<string> = new Set<HttpVia>(["request", "page", "fetch", "node:http", "node:https"]);

function entryOf(line: string): HttpLogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entry = parsed as Record<string, unknown>;
  if (typeof entry.method !== "string" || typeof entry.url !== "string" || typeof entry.status !== "number" || typeof entry.via !== "string" || !VIAS.has(entry.via)) return null;
  return parsed as HttpLogEntry;
}

/** Every line of an http.jsonl text, in order, with no entry for the empty
 * text after the last newline: a line's index is the `http.jsonl[<index>]`
 * a claim's `measured` and run.json's `http_line` name. Pure. */
export function parseHttpLog(text: string): readonly (HttpLogEntry | null)[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map(entryOf);
}
