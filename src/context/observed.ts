import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StepProcesses } from "../execution-events/tally.js";
import type { ObservedCounts, ProcessEntry, ProcessOutput, UnmeasuredEntry } from "../record/types.js";
import { redact, redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { type ChannelHttpLine, type ChannelRecorder, type PendingCapture, type SocketUse, type WaitEnd, withoutChannelRecording } from "./channels.js";
import { MAX_ENTRIES } from "./file-snapshot.js";
import { type HttpLogEntry, httpLogEntryOf } from "./http-log.js";
import type { HttpLogFailedCollector } from "./http-log-failed.js";
import { MCP_LOG_FILE_NAME, mcpLineOf, type McpCallSeen } from "./mcp-call.js";
import type { McpCallStart, McpRecorder } from "./measure-mcp.js";
import { lateProcessFileName, processOutputFileName } from "./process-output.js";
import type { ProcessRecorder } from "./run-command.js";
import { WEBSOCKET_LOG_FILE_NAME, type WebSocketSeen, webSocketLineOf } from "./websocket-line.js";
import {
  changesFromTouches,
  compareScratch,
  describeChanges,
  type Identity,
  identityOf,
  type Uninspected,
  mergeFileChanges,
  type ScratchState,
  snapshotScratch,
} from "./step-files.js";
import { newSpanId, newTraceId, originOf, stampsUrl, traceparentOf } from "./trace-context.js";

// Responsibility: what one step boundary reached outside its own code, the
// step record's `observed` (docs/spec.md "Records"): the processes
// `runCommand` (run-command.ts) started, the requests the step's process
// sent, the MCP calls it sent through a measured transport, the WebSocket
// frames, the files the step changed, and what nukadoko could not
// measure. The channel patches (channels.ts), runCommand, and measureMcp
// (measure-mcp.ts) hand it what they saw; this module owns the record's
// shape, the files beside the record (process output, and the http.jsonl,
// mcp.jsonl, and websocket.jsonl lines), and redaction of them.
//
// Owned and reset by the executor's step boundary (create-context.ts's
// `beginStep`), never reachable from a step's own `run`: a step cannot
// control its own step record or evidence collection.
//
// The rule every field follows: measure what can be measured exactly, and
// name what cannot in `unmeasured`. Nothing here infers one channel from
// another; a POST is a request, never a write.
//
// A boundary is a small state machine. It opens at `reset` and takes the
// evidence directory of that moment, and it closes once its record is
// built (`close`). A recorder handed to a step's scope (`openRun`) holds
// its boundary, not whichever boundary is current: a step that timed out,
// or left a timer behind, can keep acting after the next step starts, and
// what it does then belongs to it, never to the step that happens to be
// running. A request or a `runCommand` process that starts after its
// boundary closed is still written beside that boundary's record, marked
// `after_step_end`, and counted for the run summary, because the record
// that would have counted it is already written and is not rewritten.
//
// A request's line is appended the moment the request completes, and the
// boundary lets go of it then: what a finished request leaves in memory
// is its count. A request still open is held twice, by its boundary for
// the flush and by this module for the end of the run, so a request left
// open after its boundary closed (no flush will ever wait for it) still
// gets its line before run.json is written (`finalizeOpenRequests`).
//
// Each boundary also holds a trace id of its own when the run has a world
// (trace-context.ts): a request the boundary's code sends to the world's
// origin carries that trace id and a span id made for the request, and
// the boundary counts it. A recorder held by a step that outlived its
// boundary stamps with that boundary's trace id, for the same reason it
// records into that boundary, so the program's lines for such a request
// are that step's too.
//
// A write the step's own process makes through `node:fs` is a touch,
// recorded unless it lands in a directory nukadoko writes itself: the state
// directory and the boundary's evidence directory. The world's directory
// lies inside one of those, and the program under test keeps its state
// there, so a step's own write there is recorded like any other
// (`watchedDirs`). No walk reads it: the program writes there while the
// step runs, and a before and after walk would give the program's writes
// to the step or to a `runCommand` process. The program's own work shows
// in its log, not in `observed.files`.

/** What a step's scope holds: the recorder runCommand, the channel
 * patches, and measureMcp write into. */
export type StepRecorder = ProcessRecorder & ChannelRecorder & McpRecorder;

/** What the current boundary knows of its trace, for the step's program
 * log slice (program-log-slice.ts). */
export interface BoundaryTrace {
  readonly traceId: string;
  /** How many requests the boundary sent to the world with a
   * `traceparent`. */
  readonly stamped: number;
  /** When the boundary last stamped a request or gave a process its
   * `TRACEPARENT`, as `Date.now()` reads, or `undefined` when it did
   * neither: a slice waits for the lines of either. */
  readonly lastStampAt: number | undefined;
}

/** The boundary's trace with the span id of each request it stamped,
 * for the step's slice of the program's events (events-file.ts), which
 * matches each request to the line that reports its end. */
export interface StampedBoundaryTrace extends BoundaryTrace {
  /** The span ids the boundary sent, in the order sent, at most
   * MAX_KEPT_SPANS of them. */
  readonly spans: readonly string[];
  /** Stamped requests past MAX_KEPT_SPANS, whose span ids are not kept. */
  readonly spansNotKept: number;
  /** What the boundary's `runCommand` processes leave open, by
   * `processesOf`. */
  readonly processes: StepProcesses;
  /** The span ids of the `TRACEPARENT` values the boundary gave its
   * processes, at most MAX_KEPT_SPANS of them. */
  readonly processSpans: readonly string[];
  /** The span ids of the `traceparent` values the boundary put in its MCP
   * calls' `params._meta`, at most MAX_KEPT_SPANS of them. */
  readonly mcpSpans?: readonly string[];
}

/** How many span ids a boundary keeps: a step that sends more requests
 * than this to the world is rare, and its events count the rest. */
const MAX_KEPT_SPANS = 1000;

/** How many requests and `runCommand` processes started after a step's
 * record was written. Live: it grows while the step's code keeps running. */
export interface AfterStepEnd {
  readonly requests: number;
  readonly processes: number;
  readonly mcp: number;
}

export interface ObservedCollector extends StepRecorder {
  /** Directories `runCommand` and the file measurement leave out. */
  readonly unwatchedDirs: readonly string[];
  /** Executor-only: leaves `dir` out of the file measurement and
   * `runCommand`'s walk from now on: a directory nukadoko writes to while a
   * step runs, such as Playwright's output directory. */
  ignoreDir(dir: string): void;
  /** Executor-only: the recorder for a step's own `run`, bound to the
   * current boundary. The first call in a boundary also reads the scratch
   * directories, the "before" side of `observed.files`. */
  openRun(scratchDirs: readonly string[]): StepRecorder;
  /** Executor-only: writes at once the line of each response whose body
   * the step never started reading, waits up to `timeoutMs` for the other
   * requests still open, then writes what arrived of the rest. */
  flush(timeoutMs?: number): Promise<void>;
  /** A snapshot of what was recorded since the last `reset()` (or since
   * creation, for `nuka do`'s single execution-wide boundary).
   * `scratchDirs` is every scratch directory that exists now. */
  snapshot(scratchDirs?: readonly string[]): ObservedCounts;
  /** Executor-only: closes the current boundary once its record is built.
   * What starts in it afterwards is written with `after_step_end`. */
  close(): void;
  /** Executor-only: the current boundary's count of actions that started
   * after it closed. */
  afterStepEnd(): AfterStepEnd;
  /** Executor-only: starts a new step boundary. */
  reset(): void;
  /** Executor-only: the current boundary's trace, or `undefined` when the
   * run has no world to stamp requests for. */
  boundaryTrace(): StampedBoundaryTrace | undefined;
  /** The `traceparent` for a request to `url` sent now, in the current
   * boundary: a page's request, which runs in no step's scope. */
  traceparentFor(url: string, base?: string): string | undefined;
}

/** One boundary's measurements. */
interface Boundary {
  /** The evidence directory when the boundary opened, where its process
   * output and request lines go whenever they finish. */
  readonly dir: string | undefined;
  closed: boolean;
  readonly afterEnd: { requests: number; processes: number; mcp: number };
  processes: (ProcessEntry | undefined)[] | null;
  http: number;
  mcp: number;
  websocket: number;
  /** The requests of this boundary whose line is not written yet. */
  readonly pending: Set<PendingCapture>;
  readonly touched: Map<string, Identity | Uninspected>;
  touchesOverflowed: boolean;
  readonly unmeasured: Map<string, UnmeasuredEntry>;
  /** Each socket the step connected or wrote to, by how it first saw it. */
  readonly sockets: Map<SocketUse, "connect" | "write">;
  scratchBefore: ScratchState | undefined;
  /** The trace id requests to the world carry, `undefined` without a
   * world. */
  readonly traceId: string | undefined;
  stamped: number;
  lastStampAt: number | undefined;
  readonly spans: string[];
  spansNotKept: number;
  readonly processSpans: string[];
  readonly mcpSpans: string[];
}

function newBoundary(dir: string | undefined, traceId: string | undefined): Boundary {
  return {
    dir,
    traceId,
    stamped: 0,
    lastStampAt: undefined,
    spans: [],
    spansNotKept: 0,
    processSpans: [],
    mcpSpans: [],
    closed: false,
    afterEnd: { requests: 0, processes: 0, mcp: 0 },
    processes: null,
    http: 0,
    mcp: 0,
    websocket: 0,
    pending: new Set(),
    touched: new Map(),
    touchesOverflowed: false,
    unmeasured: new Map(),
    sockets: new Map(),
    scratchBefore: undefined,
  };
}

/** The ceiling on how long the step boundary waits for open requests. An
 * event stream never ends, and a step's record must not wait on it. */
export const FLUSH_TIMEOUT_MS = 1000;

/** How often the flush looks again for a response that became idle while
 * it waited: one that arrived during the flush, which nothing will read. */
const IDLE_CHECK_MS = 50;

/** Every request of this process whose line is not written yet, in any
 * boundary of any collector. */
const openRequests = new Set<PendingCapture>();

/** Writes the line of every request still open in this process, with
 * `status: 0` and the error that says the run ended first, or what
 * arrived of its response body. `nuka run` calls it before run.json is
 * written, and `nuka do` before it returns, so every request a step was
 * counted for has a line, a request left open after its step ended
 * included. */
export function finalizeOpenRequests(): void {
  for (const capture of [...openRequests]) capture.finalize("run");
}

function sleep(ms: number): { readonly done: Promise<void>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

/** The unmeasured entry of a socket the step used that nothing accounts
 * for at the step's end. */
function socketEntry(use: SocketUse, how: "connect" | "write"): UnmeasuredEntry {
  return { kind: "socket", detail: how === "connect" ? `connect ${use.address}` : `write to ${use.address}, a connection opened before the step` };
}

export function createObservedCollector(
  options: {
    readonly unwatchedDirs?: readonly string[];
    /** Directories inside an unwatched one, or inside the evidence
     * directory, where a write the step's own process makes is still
     * recorded: the world's directory (this file's header). Never walked. */
    readonly watchedDirs?: readonly string[];
    /** The current step boundary's evidence directory. Without it, process
     * output and request lines are not kept. */
    readonly outputDir?: () => string;
    readonly secrets?: SecretSet;
    /** Counts a request line that could not be appended to http.jsonl. */
    readonly httpLogFailed?: HttpLogFailedCollector;
    /** The prefix of the world's trace ids and the world's origin:
     * requests to that origin get a `traceparent`. Absent without a world
     * URL. */
    readonly trace?: { readonly prefix: string; readonly origin: string };
    /** Hears each request line as it is written, redacted. */
    readonly onLine?: (entry: HttpLogEntry) => void;
  } = {},
): ObservedCollector {
  const unwatchedDirs = (options.unwatchedDirs ?? []).map((dir) => path.resolve(dir));
  const secrets = options.secrets ?? [];
  const trace = options.trace;
  const openBoundary = (): Boundary => newBoundary(options.outputDir?.(), trace === undefined ? undefined : newTraceId(trace.prefix));
  let boundary = openBoundary();

  const watchedDirs = (options.watchedDirs ?? []).map((dir) => path.resolve(dir));
  const within = (target: string, dir: string): boolean => target === dir || target.startsWith(dir + path.sep);

  function isOwnPath(target: string): boolean {
    if (watchedDirs.some((dir) => within(target, dir))) return false;
    const own = options.outputDir === undefined ? unwatchedDirs : [...unwatchedDirs, path.resolve(options.outputDir())];
    return own.some((dir) => within(target, dir));
  }

  function recorderFor(
    current: () => Boundary,
  ): StepRecorder & {
    readonly unwatchedDirs: readonly string[];
    traceparentFor(url: string, base?: string): string | undefined;
    draftTraceparent(url: string, base?: string): { readonly value: string; sent(): void } | undefined;
    isWorldUrl(url: string, base?: string): boolean;
  } {
    // A request counts as stamped once nukadoko's value went out with it,
    // in the boundary the value was made for.
    const draftTraceparent = (url: string, base?: string): { readonly value: string; sent(): void } | undefined => {
      const state = current();
      if (trace === undefined || state.traceId === undefined || !stampsUrl(trace.origin, url, base)) return undefined;
      let counted = false;
      const span = newSpanId();
      return {
        value: traceparentOf(state.traceId, span),
        sent() {
          if (counted) return;
          counted = true;
          state.stamped += 1;
          state.lastStampAt = Date.now();
          if (state.spans.length < MAX_KEPT_SPANS) state.spans.push(span);
          else state.spansNotKept += 1;
        },
      };
    };
    return {
      unwatchedDirs,
      startProcess(): (entry: ProcessEntry, output?: ProcessOutput) => void {
        // Captured, not re-read at fill time: a process that outlives a
        // reset fills the list it started in, never the next step's, and
        // writes its output beside the record of the step it started in.
        const state = current();
        const late = state.closed;
        if (late) state.afterEnd.processes += 1;
        state.processes ??= [];
        const list = state.processes;
        const index = list.length;
        list.push(undefined);
        const dir = state.dir;
        return (entry, output) => {
          const kept = dir === undefined || output === undefined ? {} : keepOutput(dir, index + 1, output, secrets);
          list[index] = { ...entry, ...kept };
          if (late && dir !== undefined) keepLateProcess(dir, index + 1, { ...entry, ...kept }, secrets);
        };
      },
      startHttp(): (line: ChannelHttpLine) => void {
        const state = current();
        const late = state.closed;
        if (late) state.afterEnd.requests += 1;
        else state.http += 1;
        const dir = state.dir;
        return (line) => {
          if (dir !== undefined) appendLine(dir, line, late);
        };
      },
      track(capture: PendingCapture): () => void {
        const state = current();
        state.pending.add(capture);
        openRequests.add(capture);
        return () => {
          state.pending.delete(capture);
          openRequests.delete(capture);
        };
      },
      touchFile(target: string, before?: Identity, byPlaywrightServer?: () => boolean): void {
        const state = current();
        if (state.touched.has(target) || state.touchesOverflowed || isOwnPath(target)) return;
        // Not remembered when it is the server's: the step's own later
        // write to the same path is still the step's.
        if (byPlaywrightServer?.() === true) return;
        if (state.touched.size >= MAX_ENTRIES) {
          state.touchesOverflowed = true;
          return;
        }
        state.touched.set(target, before === undefined ? identityOf(target) : before);
      },
      markUnmeasured(entry: UnmeasuredEntry): void {
        // Each distinct action once: a step that starts the same program
        // a hundred times has one thing nukadoko could not measure.
        const key = `${entry.kind}\u0000${entry.detail}`;
        const state = current();
        if (!state.unmeasured.has(key)) state.unmeasured.set(key, entry);
      },
      noteSocket(use: SocketUse, how: "connect" | "write"): void {
        const state = current();
        if (!state.sockets.has(use)) state.sockets.set(use, how);
      },
      webSocketEvent(seen: WebSocketSeen): void {
        const state = current();
        if (!state.closed) state.websocket += 1;
        if (state.dir !== undefined) appendWebSocketLine(state.dir, seen, state.closed);
      },
      processTraceparent(): string | undefined {
        const state = current();
        if (trace === undefined || state.traceId === undefined) return undefined;
        const span = newSpanId();
        state.lastStampAt = Date.now();
        // A process's span is never waited for (tally.ts), so one past the
        // cap is only not recognized.
        if (state.processSpans.length < MAX_KEPT_SPANS) state.processSpans.push(span);
        return traceparentOf(state.traceId, span);
      },
      traceparentFor(url: string, base?: string): string | undefined {
        const draft = draftTraceparent(url, base);
        draft?.sent();
        return draft?.value;
      },
      draftTraceparent,
      isWorldUrl(url: string, base?: string): boolean {
        return trace !== undefined && stampsUrl(trace.origin, url, base);
      },
      startMcpCall(stamp: boolean, atEnd: (end: WaitEnd) => McpCallSeen): McpCallStart {
        return startMcpCall(current(), stamp, atEnd, recorderFor);
      },
    };
  }

  // One MCP call (measure-mcp.ts): counted in the boundary it started in,
  // with a span of its own when nukadoko stamps it. The transport's send
  // runs under a recorder of the same boundary whose `traceparent` for a
  // request to the world is the call's, so an HTTP transport's request
  // carries the value `params._meta` does and is counted as a stamped
  // request with that span, once however many requests the send makes.
  function startMcpCall(
    state: Boundary,
    stamp: boolean,
    atEnd: (end: WaitEnd) => McpCallSeen,
    recorderOf: (current: () => Boundary) => StepRecorder,
  ): McpCallStart {
    const late = state.closed;
    if (late) state.afterEnd.mcp += 1;
    else state.mcp += 1;
    const dir = state.dir;
    const span = stamp && trace !== undefined && state.traceId !== undefined ? newSpanId() : undefined;
    const traceparent = span === undefined ? undefined : traceparentOf(state.traceId!, span);
    if (span !== undefined) {
      state.lastStampAt = Date.now();
      if (state.mcpSpans.length < MAX_KEPT_SPANS) state.mcpSpans.push(span);
    }
    const headerSentTo: string[] = [];
    let spanSent = false;
    const draft = (url: string, base?: string): { readonly value: string; sent(): void } | undefined => {
      if (traceparent === undefined || trace === undefined || !stampsUrl(trace.origin, url, base)) return undefined;
      let counted = false;
      return {
        value: traceparent,
        sent() {
          if (counted) return;
          counted = true;
          state.stamped += 1;
          state.lastStampAt = Date.now();
          if (!spanSent) {
            spanSent = true;
            if (state.spans.length < MAX_KEPT_SPANS) state.spans.push(span!);
            else state.spansNotKept += 1;
          }
          const origin = originOf(url, base);
          if (origin !== undefined && !headerSentTo.includes(origin)) headerSentTo.push(origin);
        },
      };
    };
    const sending: StepRecorder | undefined =
      traceparent === undefined
        ? undefined
        : {
            ...recorderOf(() => state),
            draftTraceparent: draft,
            traceparentFor(url: string, base?: string): string | undefined {
              const drafted = draft(url, base);
              drafted?.sent();
              return drafted?.value;
            },
          };
    let written = false;
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const release = recorderOf(() => state).track({ done, finalize: (end) => write(atEnd(end)) });
    function write(seen: McpCallSeen): void {
      if (written) return;
      written = true;
      if (typeof release === "function") release();
      settle();
      if (dir !== undefined) appendMcpLine(dir, seen, headerSentTo, late);
    }
    return { traceparent, sending, write };
  }

  function appendMcpLine(dir: string, seen: McpCallSeen, headerSentTo: readonly string[], late: boolean): void {
    const line = { ...mcpLineOf(seen, headerSentTo, secrets), ...(late ? { after_step_end: true as const } : {}) };
    const text = `${JSON.stringify(redact(line, secrets))}\n`;
    withoutChannelRecording(() => {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(path.join(dir, MCP_LOG_FILE_NAME), text);
      } catch {
        // Left out, as a process's output is: the call already happened,
        // and `observed.mcp` still counts it.
      }
    });
  }

  function appendWebSocketLine(dir: string, seen: WebSocketSeen, late: boolean): void {
    const line = { ...webSocketLineOf(seen, new Date(), secrets), ...(late ? { after_step_end: true as const } : {}) };
    withoutChannelRecording(() => {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(path.join(dir, WEBSOCKET_LOG_FILE_NAME), `${JSON.stringify(line)}\n`);
      } catch {
        // Left out, as an MCP call's line is: the frame already went, and
        // `observed.websocket` still counts it.
      }
    });
  }

  function appendLine(dir: string, line: ChannelHttpLine, late: boolean): void {
    const entry = { ...httpLogEntryOf(line, secrets), ...(late ? { after_step_end: true as const } : {}) };
    const redacted = redact(entry, secrets) as typeof entry;
    options.onLine?.(redacted);
    const text = `${JSON.stringify(redacted)}\n`;
    withoutChannelRecording(() => {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(path.join(dir, "http.jsonl"), text);
      } catch {
        // Counted, not thrown: the request already happened, and the
        // step record's `http_log_failed` says a line is missing.
        options.httpLogFailed?.record();
      }
    });
  }

  return {
    ...recorderFor(() => boundary),
    ignoreDir(dir: string): void {
      const resolved = path.resolve(dir);
      if (!unwatchedDirs.includes(resolved)) unwatchedDirs.push(resolved);
    },
    openRun(scratchDirs: readonly string[]): StepRecorder {
      const state = boundary;
      state.scratchBefore ??= snapshotScratch(scratchDirs, unwatchedDirs);
      return recorderFor(() => state);
    },
    async flush(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
      // A request the step's leftover code starts while the flush waits is
      // waited for too, within the same deadline. Each capture removes
      // itself from `pending` as its line is written.
      const state = boundary;
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        for (const capture of [...state.pending]) if (capture.idle?.() === true) capture.finalize("step");
        if (state.pending.size === 0) return;
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        const slice = sleep(Math.min(remaining, IDLE_CHECK_MS));
        await Promise.race([Promise.allSettled([...state.pending].map((capture) => capture.done)), slice.done]);
        slice.cancel();
      }
      for (const capture of [...state.pending]) capture.finalize("step");
    },
    snapshot(scratchDirs: readonly string[] = []): ObservedCounts {
      const state = boundary;
      const processes = state.processes?.filter((entry): entry is ProcessEntry => entry !== undefined) ?? null;
      const scratch =
        state.scratchBefore === undefined
          ? { changes: [], unmeasured: [] }
          : compareScratch(state.scratchBefore, scratchDirs, unwatchedDirs);
      const touches = changesFromTouches(state.touched, identityOf);
      const changes = mergeFileChanges(scratch.changes, touches.changes);
      const files = changes.length === 0 ? null : withoutChannelRecording(() => describeChanges(changes, secrets));
      const sockets = new Map<string, UnmeasuredEntry>();
      for (const [use, how] of state.sockets) {
        if (use.owned) continue;
        const entry = socketEntry(use, how);
        sockets.set(entry.detail, entry);
      }
      const unmeasured: UnmeasuredEntry[] = [
        ...state.unmeasured.values(),
        ...sockets.values(),
        ...scratch.unmeasured,
        ...touches.uninspected.map(({ path: target, error }) => ({ kind: "files" as const, detail: `${target} could not be inspected: ${error}` })),
        ...(state.touchesOverflowed
          ? [{ kind: "files" as const, detail: `more than ${MAX_ENTRIES} paths written; the rest are not listed` }]
          : []),
      ];
      return {
        processes,
        http: state.http === 0 ? null : state.http,
        files,
        unmeasured,
        ...(state.mcp === 0 ? {} : { mcp: state.mcp }),
        ...(state.websocket === 0 ? {} : { websocket: state.websocket }),
      };
    },
    close(): void {
      boundary.closed = true;
    },
    afterStepEnd(): AfterStepEnd {
      return boundary.afterEnd;
    },
    reset(): void {
      boundary = openBoundary();
    },
    boundaryTrace(): StampedBoundaryTrace | undefined {
      const state = boundary;
      if (state.traceId === undefined) return undefined;
      return {
        traceId: state.traceId,
        stamped: state.stamped,
        lastStampAt: state.lastStampAt,
        spans: [...state.spans],
        spansNotKept: state.spansNotKept,
        processes: processesOf(state.processes),
        processSpans: [...state.processSpans],
        mcpSpans: [...state.mcpSpans],
      };
    },
  };
}

/** What a boundary's processes leave open: a process still running has no
 * entry yet, and only an entry whose group ended bounds what the process
 * sent (src/context/run-command.ts). An entry from an older copy of
 * runCommand, or from Windows, names no group. */
function processesOf(entries: readonly (ProcessEntry | undefined)[] | null): StepProcesses {
  if (entries === null || entries.length === 0) return "none";
  return entries.every((entry) => entry?.group === "ended") ? "ended" : "unbounded";
}

/** Writes the entry of a `runCommand` process that started after its
 * step's record was written, beside that record, since the record cannot
 * hold it. A taken name moves to the next number, as output files do. */
function keepLateProcess(dir: string, position: number, entry: ProcessEntry, secrets: SecretSet): void {
  const text = `${JSON.stringify(redact({ ...entry, after_step_end: true }, secrets), null, 2)}\n`;
  withoutChannelRecording(() => {
    try {
      mkdirSync(dir, { recursive: true });
      for (let n = position; ; n += 1) {
        try {
          writeFileSync(path.join(dir, lateProcessFileName(n)), text, { flag: "wx" });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    } catch {
      // Left out, as keepOutput leaves a stream out: the program already
      // ran, and the run summary still counts it.
    }
  });
}

/** Writes each non-empty stream to its file and returns the entry fields
 * that name them. The file is created, never replaced: hooks of one
 * scenario share an evidence directory and each counts its processes from
 * 1, so a taken name moves to the next number. A stream that could not be
 * written is left out rather than failing the step: the program already
 * ran, and its exit code and files are still measured. */
function keepOutput(
  dir: string,
  position: number,
  output: ProcessOutput,
  secrets: SecretSet,
): { stdout?: string; stderr?: string; stdin?: string } {
  const kept: { stdout?: string; stderr?: string; stdin?: string } = {};
  for (const stream of ["stdout", "stderr", "stdin"] as const) {
    const raw = output[stream];
    if (raw === undefined || raw === "") continue;
    const text = redactString(raw, secrets);
    withoutChannelRecording(() => {
      try {
        mkdirSync(dir, { recursive: true });
        for (let n = position; ; n += 1) {
          const name = processOutputFileName(n, stream);
          try {
            writeFileSync(path.join(dir, name), text, { flag: "wx" });
            kept[stream] = name;
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
      } catch {
        // Left out, as the comment above says.
      }
    });
  }
  return kept;
}
