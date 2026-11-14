import { performance } from "node:perf_hooks";
import type { WaitEnd } from "./channels.js";
import { firstLine } from "./channels.js";
import { answeredId, idKey, type JsonRpcMessage, type McpCallSeen, outgoingOf, stampTraceparent, traceparentIn } from "./mcp-call.js";
import { type ProcessRecorder, withProcessRecording } from "./run-command.js";

// Responsibility: `measureMcp`, the exported helper that makes the MCP
// calls a step sends through a client's transport part of the step record
// (docs/spec.md "Records"): each request and notification the client
// sends becomes a line of the step's mcp.jsonl with the answer it got, and
// carries the step's trace context in `params._meta.traceparent`
// (mcp-call.ts), so the server's log lines and execution events for the
// call are the step's. It decides no verdict: an `isError` result or a
// JSON-RPC error is an answer the step reads.
//
// It wraps the transport, not the client. A transport is the small
// structural interface every MCP SDK client is built on (`start`, `send`,
// `close`, and the `onmessage`, `onerror`, and `onclose` callbacks), so a
// project keeps the official client, and nukadoko imports no SDK. The
// wrapper is a Proxy: every other member of the transport (a stdio
// transport's `stderr` and `pid`, an HTTP transport's `sessionId` and
// `terminateSession`) is the transport's own, and `instanceof` still holds.
//
// It is an import, not a member of `ctx`, for the reason runCommand is:
// it finds the step through the scope the executor opens around a step's
// `run` (run-command.ts), at each `send`. A client is usually connected in
// a scenario fixture, outside every step, and called from several steps,
// so a value bound when the transport was built would hold the wrong step.
// The trace context and the record stay the executor's: the wrapper asks
// the step's recorder for both (observed.ts), and records nothing outside
// a step, where it passes every message through untouched.
//
// An answer arrives in the transport's own callback, outside the step's
// async context, so each call keeps the recorder of the step that sent it,
// and its answer is written there by id, whenever it arrives. A call with
// no answer when the step's record is written is written then as
// unanswered (the recorder's `track`, the same wait an open HTTP request
// gets). A call left open when the transport closes is written as
// unanswered too.
//
// Over HTTP, the transport sends each message as a request. The send runs
// under a recorder whose `traceparent` for a request to the world is the
// call's own, so the header and `params._meta` carry one value, and the
// program's `request` line for that HTTP request closes the call the way
// it closes any stamped request (src/execution-events/tally.ts). Over
// stdio no line can close a call: that is the `mcp-unbounded` gap.
//
// Recording never throws into the transport or the client: a failure to
// record is a missing line, never a failed call.

/** The structural transport of an MCP client: the members this wrapper
 * reads. A transport of any SDK version that has these fits. */
export interface McpTransport {
  start(): Promise<void>;
  send(message: never, options?: never): Promise<void>;
  close(): Promise<void>;
  onmessage?: ((message: never, extra?: never) => void) | undefined;
  onclose?: (() => void) | undefined;
}

/** One call the recorder holds until its line is written. */
export interface McpCallStart {
  /** nukadoko's `traceparent` for the call, `undefined` when the run has
   * no world or the call keeps the step's own. */
  readonly traceparent: string | undefined;
  /** The recorder the transport's send runs under, so an HTTP request it
   * sends to the world carries `traceparent` as its header. */
  readonly sending: ProcessRecorder | undefined;
  /** Writes the call's line, once. */
  write(seen: McpCallSeen): void;
}

/** What a step's recorder offers this wrapper. Optional, so a recorder
 * from an older copy of nukadoko still fits, and records no call. */
export interface McpRecorder {
  startMcpCall?(stamp: boolean, atEnd: (end: WaitEnd) => McpCallSeen): McpCallStart;
}

const SCOPE_KEY = Symbol.for("nukadoko.runCommand.scope");

function stepRecorder(): McpRecorder | undefined {
  try {
    const holder = globalThis as { [SCOPE_KEY]?: { getStore(): unknown } };
    const store = holder[SCOPE_KEY]?.getStore() as McpRecorder | undefined;
    return typeof store?.startMcpCall === "function" ? store : undefined;
  } catch {
    return undefined;
  }
}

interface Open {
  readonly call: McpCallStart;
  readonly message: JsonRpcMessage;
  readonly startedAt: number;
}

/** `transport`, measured: pass it to the MCP client's `connect` in its
 * place (module header). */
export function measureMcp<T extends McpTransport>(transport: T): T {
  const open = new Map<string, Open>();
  let onmessage: ((message: unknown, extra?: unknown) => void) | undefined;
  let onclose: (() => void) | undefined;
  const elapsed = (startedAt: number): number => Math.round(performance.now() - startedAt);
  const settle = (key: string, seen: (entry: Open) => McpCallSeen): void => {
    const entry = open.get(key);
    if (entry === undefined) return;
    open.delete(key);
    try {
      entry.call.write(seen(entry));
    } catch {
      // A missing line, never a failed call (module header).
    }
  };
  const target = transport as unknown as Record<PropertyKey, unknown> & {
    send(message: unknown, options?: unknown): Promise<void>;
    onmessage?: (message: unknown, extra?: unknown) => void;
    onclose?: () => void;
  };
  const heard = (message: unknown, extra?: unknown): void => {
    const id = answeredId(message);
    if (id !== undefined) settle(idKey(id), (entry) => ({ message: entry.message, end: { answer: message as JsonRpcMessage, duration_ms: elapsed(entry.startedAt) } }));
    onmessage?.(message, extra);
  };
  const closed = (): void => {
    for (const key of [...open.keys()]) settle(key, (entry) => ({ message: entry.message, end: { unanswered: "closed" } }));
    onclose?.();
  };
  async function send(message: unknown, options?: unknown): Promise<void> {
    const outgoing = outgoingOf(message);
    const recorder = outgoing.kind === "other" ? undefined : stepRecorder();
    if (recorder === undefined || outgoing.kind === "other") return target.send(message, options);
    let call: McpCallStart;
    let sent: JsonRpcMessage = message as JsonRpcMessage;
    const startedAt = performance.now();
    const key = outgoing.kind === "request" ? idKey(outgoing.id) : undefined;
    try {
      call = recorder.startMcpCall!(traceparentIn(message) === undefined, (end) => ({ message: sent, end: { unanswered: end } }));
      if (call.traceparent !== undefined) sent = stampTraceparent(sent, call.traceparent).message;
      if (key === undefined) call.write({ message: sent, end: { notification: true } });
      else open.set(key, { call, message: sent, startedAt });
    } catch {
      return target.send(message, options);
    }
    const sending = call.sending;
    try {
      await (sending === undefined ? target.send(sent, options) : withProcessRecording(sending, () => target.send(sent, options)));
    } catch (error) {
      if (key !== undefined) settle(key, (entry) => ({ message: entry.message, end: { send_error: firstLine(error), duration_ms: elapsed(entry.startedAt) } }));
      throw error;
    }
  }
  target.onmessage = heard;
  target.onclose = closed;
  return new Proxy(transport, {
    get(object, property) {
      if (property === "send") return send;
      if (property === "onmessage") return onmessage;
      if (property === "onclose") return onclose;
      const value: unknown = Reflect.get(object, property, object);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    },
    set(object, property, value) {
      if (property === "onmessage") onmessage = value as typeof onmessage;
      else if (property === "onclose") onclose = value as typeof onclose;
      else return Reflect.set(object, property, value, object);
      return true;
    },
  });
}
