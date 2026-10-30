import type { KeptText, McpCallLine } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { BODY_CAP, keepBody, windowFor } from "./kept-text.js";

// Responsibility: what one MCP call is, as a step record keeps it
// (docs/spec.md "Records"): which messages a client sends that are calls,
// the trace context a call carries in `params._meta`, which answer closes
// which call, and the mcp.jsonl line a call and its answer make. Pure: no
// I/O and no state. measure-mcp.ts sees the messages; observed.ts writes
// the lines.
//
// The trace context goes in `params._meta.traceparent`, the key MCP
// documents for W3C Trace Context (SEP-414, after the OpenTelemetry
// semantic conventions for MCP), so a server that already reads it needs
// nothing new. A `traceparent` the caller put there is kept, the rule a
// request's own `traceparent` header follows. Only a message whose
// `params` is an object, or absent, is stamped: JSON-RPC also allows
// positional `params`, and an array has no place for the key.
//
// The params and the result are kept as the JSON text of what was sent
// and received, redacted and cut the way an HTTP body is (kept-text.ts),
// so a large tool result is bounded by the same cap and a secret in a
// tool's arguments never reaches the record. A JSON-RPC error keeps its
// code and the first line of its message: a message can carry a stack.
//
// Which field names a call's target is a table, so a method MCP adds
// later is one more row.

/** The file beside a step record that holds its MCP calls, one line
 * each. */
export const MCP_LOG_FILE_NAME = "mcp.jsonl";

/** A JSON-RPC message as an MCP transport carries it: only the members
 * this module reads, any of which may be missing or of another type. */
export interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** What a message the client sends is to a step record: a request, which
 * an answer closes; a notification, which none does; or neither (the
 * client's answer to a request the server sent, or no message at all). */
export type Outgoing =
  | { readonly kind: "request"; readonly id: string | number; readonly method: string }
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "other" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

export function outgoingOf(message: unknown): Outgoing {
  if (!isObject(message) || typeof message.method !== "string") return { kind: "other" };
  if (!("id" in message)) return { kind: "notification", method: message.method };
  return isId(message.id) ? { kind: "request", id: message.id, method: message.method } : { kind: "other" };
}

/** The id of the call `message` answers, when it is an answer: an id, no
 * method, and a `result` or an `error`. */
export function answeredId(message: unknown): string | number | undefined {
  if (!isObject(message) || "method" in message || !isId(message.id)) return undefined;
  return "result" in message || "error" in message ? message.id : undefined;
}

/** A key that tells `1` from `"1"`: JSON-RPC answers with the id as sent. */
export function idKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

/** The `traceparent` in `message.params._meta`, when it is a string. */
export function traceparentIn(message: unknown): string | undefined {
  if (!isObject(message) || !isObject(message.params) || !isObject(message.params._meta)) return undefined;
  const value = message.params._meta.traceparent;
  return typeof value === "string" ? value : undefined;
}

/** `message` with `traceparent` in `params._meta`, as a new object:
 * `stamped` is false, and the message is the one given, when its params
 * already carry a `traceparent` or are not an object (module header). */
export function stampTraceparent<M>(message: M, traceparent: string): { readonly message: M; readonly stamped: boolean } {
  if (!isObject(message) || traceparentIn(message) !== undefined) return { message, stamped: false };
  const params = message.params;
  if (params !== undefined && !isObject(params)) return { message, stamped: false };
  const meta = params !== undefined && isObject(params._meta) ? params._meta : {};
  return { message: { ...message, params: { ...params, _meta: { ...meta, traceparent } } } as M, stamped: true };
}

/** The params member that names each method's target, by the line field
 * that keeps it (module header). */
const TARGETS: Readonly<Record<string, { readonly field: "tool" | "prompt" | "uri"; readonly param: string }>> = {
  "tools/call": { field: "tool", param: "name" },
  "prompts/get": { field: "prompt", param: "name" },
  "resources/read": { field: "uri", param: "uri" },
  "resources/subscribe": { field: "uri", param: "uri" },
  "resources/unsubscribe": { field: "uri", param: "uri" },
};

function targetOf(method: string, params: unknown): Partial<Record<"tool" | "prompt" | "uri", string>> {
  const target = TARGETS[method];
  if (target === undefined || !isObject(params)) return {};
  const value = params[target.param];
  return typeof value === "string" ? { [target.field]: value } : {};
}

/** `value` as JSON text, kept as a body is. */
function keptJson(value: unknown, secrets: SecretSet): KeptText {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return { unread: "not JSON text" };
  }
  if (text === undefined) return { unread: "not JSON text" };
  const bytes = Buffer.from(text, "utf8");
  return keepBody({ window: bytes.subarray(0, windowFor(BODY_CAP)), total: bytes.length }, secrets);
}

function errorOf(error: unknown, secrets: SecretSet): { readonly code: number | null; readonly message: string } {
  const code = isObject(error) && typeof error.code === "number" ? error.code : null;
  const message = isObject(error) && typeof error.message === "string" ? (error.message.split("\n", 1)[0] ?? "") : "";
  return { code, message: redactString(message, secrets) };
}

/** How a call ended, as the transport saw it. */
export type McpCallEnd =
  | { readonly answer: JsonRpcMessage; readonly duration_ms: number }
  | { readonly unanswered: "step" | "run" | "closed" }
  | { readonly send_error: string; readonly duration_ms: number }
  | { readonly notification: true };

/** One call as the transport saw it: the message as sent, and its end. */
export interface McpCallSeen {
  readonly message: JsonRpcMessage;
  readonly end: McpCallEnd;
}

/** The mcp.jsonl line of `seen`, its text redacted with `secrets`.
 * `headerSentTo` are the origins that received the call's `traceparent`
 * as an HTTP header. */
export function mcpLineOf(seen: McpCallSeen, headerSentTo: readonly string[], secrets: SecretSet): McpCallLine {
  const { message, end } = seen;
  const method = typeof message.method === "string" ? message.method : "";
  const traceparent = traceparentIn(message);
  const answer = "answer" in end ? end.answer : undefined;
  const result = answer !== undefined && "result" in answer ? answer.result : undefined;
  return {
    method: redactString(method, secrets),
    ...(isId(message.id) ? { id: typeof message.id === "string" ? redactString(message.id, secrets) : message.id } : {}),
    ...("notification" in end ? { notification: true as const } : {}),
    ...Object.fromEntries(Object.entries(targetOf(method, message.params)).map(([field, value]) => [field, redactString(value, secrets)])),
    ...(message.params === undefined ? {} : { params: keptJson(message.params, secrets) }),
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(headerSentTo.length === 0 ? {} : { header_sent_to: [...headerSentTo] }),
    ...("duration_ms" in end ? { duration_ms: end.duration_ms } : {}),
    ...(answer !== undefined && "result" in answer ? { result: keptJson(result, secrets) } : {}),
    ...(isObject(result) && result.isError === true ? { is_error: true as const } : {}),
    ...(answer !== undefined && "error" in answer ? { error: errorOf(answer.error, secrets) } : {}),
    ...("unanswered" in end ? { unanswered: end.unanswered } : {}),
    ...("send_error" in end ? { send_error: redactString(end.send_error, secrets) } : {}),
  };
}
