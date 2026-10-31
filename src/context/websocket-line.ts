import type { WebSocketLine } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { BODY_CAP, keepText, windowFor } from "./kept-text.js";

// Responsibility: what one WebSocket event is, as a step record keeps it
// (docs/spec.md "Records"): the websocket.jsonl line for a socket that
// opened, a frame sent or received, and a socket that closed. Pure: no
// I/O and no state. channels.ts sees the events; observed.ts writes the
// lines.
//
// A text frame is kept the way an HTTP body is (kept-text.ts): redacted,
// then cut at the cap. A binary frame keeps its size only, since bytes
// decoded as text would be text the program never sent.

/** The file beside a step record that holds its WebSocket events, one
 * line each. */
export const WEBSOCKET_LOG_FILE_NAME = "websocket.jsonl";

/** One WebSocket event a patch saw, before redaction. `socket` numbers
 * the socket within the process, so two sockets to one URL stay apart. */
export type WebSocketSeen = { readonly socket: number; readonly url: string } & (
  | { readonly event: "open"; readonly protocol: string }
  | { readonly event: "sent" | "received"; readonly data: unknown }
  | { readonly event: "close"; readonly code: number; readonly reason: string }
);

const WINDOW = windowFor(BODY_CAP);

/** The size of a frame's data in bytes, or `undefined` for a value that
 * is no frame data. */
function byteLength(data: unknown): number | undefined {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob === "function" && data instanceof Blob) return data.size;
  return undefined;
}

function dataFields(data: unknown, secrets: SecretSet): Pick<WebSocketLine, "data" | "truncated" | "bytes" | "binary"> {
  if (typeof data === "string") {
    const bytes = Buffer.from(data, "utf8");
    const kept = keepText(bytes.subarray(0, WINDOW), bytes.length <= WINDOW, BODY_CAP, secrets);
    return "text" in kept
      ? { data: kept.text, ...(kept.truncated === true ? { truncated: true as const } : {}), bytes: bytes.length }
      : { binary: true, bytes: bytes.length };
  }
  const bytes = byteLength(data);
  return { binary: true, ...(bytes === undefined ? {} : { bytes }) };
}

/** The websocket.jsonl line for `seen`, at `at`. */
export function webSocketLineOf(seen: WebSocketSeen, at: Date, secrets: SecretSet): WebSocketLine {
  const base = { event: seen.event, socket: seen.socket, url: redactString(seen.url, secrets), at: at.toISOString() };
  if (seen.event === "open") return { ...base, ...(seen.protocol === "" ? {} : { protocol: seen.protocol }) };
  if (seen.event === "close") return { ...base, code: seen.code, ...(seen.reason === "" ? {} : { reason: redactString(seen.reason, secrets) }) };
  return { ...base, ...dataFields(seen.data, secrets) };
}
