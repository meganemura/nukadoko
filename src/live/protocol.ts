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

/** One line of JSON, `\n`-terminated — the one framing rule both sides of
 * this socket share. */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
