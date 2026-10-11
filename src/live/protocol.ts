import type { StepRecord } from "../record/types.js";

// Responsibility: the wire shape a live session's own unix socket speaks
// (docs/spec.md "Live sessions"), plus the line-delimited JSON framing both
// the daemon (daemon.ts) and its callers (cli/do.ts, cli/session.ts, via
// client.ts) use to write and read it. One connection carries exactly one
// request and exactly one response, each one line of JSON terminated by
// `\n` — no multiplexing, no persistent request stream, since a live
// session only ever runs one execution at a time anyway (docs/spec.md: "a
// second `do` against a busy session is refused rather than queued").
//
// The reply union below is closed. `parseLiveResponse` is the check that
// keeps a JSON value outside it from being treated as a member. A cast of
// `JSON.parse` would let that value reach a switch TypeScript considers
// exhaustive, and a switch with no matching arm returns undefined, which
// the process treats as a successful exit and prints nothing about.
//
// The request names a step by its vocabulary *name*, never code: a socket
// that accepted anything else (a function body, a module path) would be
// `eval` with extra steps, and the point of this boundary is that only the
// session's own already-discovered vocabulary is reachable through it.

/** One `nuka do --session <name>` call, forwarded to that session's own
 * daemon instead of building a fresh `ctx`. `args` is exactly what `--args`
 * deserialized to, unvalidated — the daemon's own vocabulary is what
 * validates it, the same way `nuka do`'s own setup phase already does for a
 * non-live call. `use` mirrors `nuka do --use` (repeatable record ids);
 * omitted, not `[]`, when no `--use` was given, matching every other
 * "absent means unused" convention record shapes in this package already
 * follow. */
export interface LiveDoRequest {
  readonly kind: "do";
  readonly step: string;
  readonly args: unknown;
  readonly use?: readonly string[];
}

/** `nuka session stop <name>`, sent over the same socket rather than a
 * second mechanism (docs/spec.md "Live sessions": stopping writes
 * storageState "to the same cache/sessions/<env>/<name>.json a session has
 * always left behind") — the daemon is the only process that can actually
 * do that write, so stopping has to reach it, not merely delete its files
 * out from under it. */
export interface LiveStopRequest {
  readonly kind: "stop";
}

export type LiveRequest = LiveDoRequest | LiveStopRequest;

/** A successful execution's own step record — the exact same shape `nuka
 * do` already prints to stdout for a non-live call, so a caller relaying
 * this needs no separate rendering path for the two. */
export interface LiveRecordResponse {
  readonly status: "record";
  readonly record: StepRecord;
}

/** A request this session refused before anything ran — a busy session (one
 * execution at a time), an unknown step, a setup failure `nuka do`'s own
 * non-live setup phase would also refuse. No step record exists for a
 * refusal: the execution never began (docs/spec.md: "an execution that
 * never began must not be citable"). */
export interface LiveRejectedResponse {
  readonly status: "rejected";
  readonly message: string;
}

/** Acknowledges a `LiveStopRequest`: this session's own storageState has
 * been persisted and its process is tearing itself down. Sent *before* the
 * daemon actually exits, so the caller's connection is not left waiting on
 * a process that is about to disappear. */
export interface LiveStoppedResponse {
  readonly status: "stopped";
}

export type LiveResponse = LiveRecordResponse | LiveRejectedResponse | LiveStoppedResponse;

export type ParsedLiveResponse =
  | { readonly ok: true; readonly response: LiveResponse }
  | { readonly ok: false; readonly message: string };

const REPLY_STATUS_MAX = 80;

function isReplyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A status is quoted into a one-line stderr message. Control characters,
// quotes, and backslashes would split that line or close the quotes early,
// so a status that contains them is reported without being interpolated.
function quotableStatus(status: string): boolean {
  if (status.length === 0 || status.length > REPLY_STATUS_MAX) {
    return false;
  }
  for (let i = 0; i < status.length; i += 1) {
    const code = status.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || status[i] === '"' || status[i] === "\\") {
      return false;
    }
  }
  return true;
}

function unrecognizedReplyDetail(value: unknown): string {
  if (isReplyObject(value) && typeof value.status === "string" && quotableStatus(value.status)) {
    return `status "${value.status}"`;
  }
  return "no known status";
}

/**
 * Narrows one decoded JSON value to the live-session reply union.
 * `ok: false` is every other value, including `null`, a non-object, and an
 * object whose `status` this side does not know. The `message` is a single
 * line a caller can append to its own sentence; it names a status only when
 * that status can be quoted safely.
 *
 * A `"record"` reply's `record` is returned as the daemon sent it. That
 * object is a step record the rest of the tool already produced, and a
 * second schema here would be free to drift from the one that wrote it.
 * The cast through `unknown` records that this function accepts the object
 * without checking it against `StepRecord`. A missing or non-object
 * `record` is not that envelope, so it is refused.
 */
export function parseLiveResponse(value: unknown): ParsedLiveResponse {
  if (!isReplyObject(value)) {
    return { ok: false, message: unrecognizedReplyDetail(value) };
  }
  if (value.status === "record") {
    if (!isReplyObject(value.record)) {
      return { ok: false, message: unrecognizedReplyDetail(value) };
    }
    return {
      ok: true,
      response: { status: "record", record: value.record as unknown as StepRecord },
    };
  }
  if (value.status === "rejected") {
    if (typeof value.message !== "string") {
      return { ok: false, message: unrecognizedReplyDetail(value) };
    }
    return { ok: true, response: { status: "rejected", message: value.message } };
  }
  if (value.status === "stopped") {
    return { ok: true, response: { status: "stopped" } };
  }
  return { ok: false, message: unrecognizedReplyDetail(value) };
}

/** One line of JSON, `\n`-terminated — the one framing rule both sides of
 * this socket share. */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
