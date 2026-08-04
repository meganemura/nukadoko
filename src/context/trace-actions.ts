import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { WritableSink } from "../cli/writable-sink.js";

// Responsibility: turn one step's own trace.zip (browser-evidence.ts's
// per-step chunk, opened/closed by create-context.ts) into the receipt's
// `actions` field (p3a-trace-per-step task spec) — every Playwright call
// that step made through `ctx.page()`, `expect` waits included, without a
// step ever needing an `expect` fixture of its own (docs/spec.md's design:
// trace records a call at Playwright's own layer, underneath whichever
// wrapper — `@playwright/test`'s `expect`, a step's own code — called it).
//
// Reads `trace.trace` only, the one entry inside trace.zip this task's spec
// already measured the shape of ("前提", not re-verified here):
// `trace.stacks` carries local absolute paths (never worth reading, and a
// portability/redaction risk if it were), `resources/*` is the recorded
// page's own assets (irrelevant to "what did this step do"). The zip reader
// below (`readZipEntry`) uses only `node:zlib`'s `inflateRawSync` — no new
// dependency, per this task's spec — walking the zip's own end-of-central-
// directory record, then its central directory, then the one local file
// header it points at for `trace.trace`, exactly the path this task's spec
// already measured works.
//
// Any parse failure here (corrupt zip, a missing `trace.trace` entry, a
// malformed JSON line, a header missing `wallTime`/`monotonicTime`) means
// `actions` is silently omitted from the receipt — the same "measurement
// must never break execution" rule `observed`/`page_events` already follow;
// a step's own status is never at the mercy of how well this file happens
// to parse. The one exception is a trace format version this build does not
// know how to read (`KNOWN_TRACE_VERSIONS` below): that is not a parse bug
// to swallow quietly, since the trace itself exists and is readable enough
// to name its own version, so `collectTraceEvidence`'s caller is told once,
// on stderr, rather than a `status: "ok"` receipt silently missing a field a
// reader has no way to know was ever expected. Guessing at a shape this
// build has never verified would violate the same rule (CLAUDE.md: "Do not
// automate a verdict on top of a proxy" — a version this code has not
// checked against is exactly that), so nothing is inferred; the version is
// simply read and compared against the closed list below.

/** Trace format versions this build knows how to read (this task's spec,
 * "前提": entries measured against version 8). Extend this list, never
 * relax the check itself, when a newer Playwright's own trace format is
 * measured and found compatible — guessing that an unmeasured version is
 * "probably fine" is exactly what this file's own header rules out. */
const KNOWN_TRACE_VERSIONS: readonly number[] = [8];

/** Capped the same way `page_events` is (src/context/page-events.ts) — a
 * step that clicks through a long flow can rack up hundreds of trace calls,
 * and a receipt trying to hold all of them stops being something a reader
 * can open. The full, uncapped list always still exists in trace.zip. */
const MAX_ACTIONS = 100;

/** One Playwright call this step made, read out of its own trace chunk
 * (docs/spec.md "Receipts"). `params` beyond the five below are never
 * carried onto the receipt (this file's own header, allowlist reasoning) —
 * `setContent`'s own HTML body is the case that motivated it: a value that
 * can run to kilobytes, next to nothing a reader needs that trace.zip
 * doesn't already have in full. */
export interface ActionEntry {
  /** The Playwright call's own method name (`"expect"`, `"goto"`, `"click"`,
   * `"setContent"`, ...) — trace's own `before.method`, unmodified. */
  readonly method: string;
  /** `before.params.expression` (an `expect` call's own matcher name, e.g.
   * `"to.be.visible"`) when the call carried one. */
  readonly expression?: string;
  /** `before.params.selector` when the call carried one. */
  readonly selector?: string;
  /** `before.params.url` when the call carried one (a `goto`, for one). */
  readonly url?: string;
  /** `before.params.isNot` (an `expect` call's own `.not`) when the call
   * carried one. */
  readonly is_not?: boolean;
  /** `before.params.timeout` (the call's own declared timeout, in ms) when
   * the call carried one. */
  readonly timeout_ms?: number;
  /** `after.endTime - before.startTime`, rounded to the nearest
   * millisecond — the call's own duration, on the trace's own clock. */
  readonly ms: number;
  /** `"failed"` when the trace's own `after` entry carried an `error`,
   * `"passed"` otherwise. */
  readonly outcome: "passed" | "failed";
  /** ISO 8601, converted from the trace's own monotonic clock via the
   * header's `wallTime`/`monotonicTime` pair (this file's own header) — the
   * same absolute timeline `sections`/`polls`/`evidence.screenshots[].at`
   * already share. */
  readonly at: string;
}

export type TraceActionsParseResult =
  | { readonly kind: "ok"; readonly actions: readonly ActionEntry[]; readonly truncatedCount?: number }
  | { readonly kind: "unknown-version"; readonly version: number }
  | { readonly kind: "unreadable" };

/** The receipt-shaped result of reading one step's own trace.zip — `trace`
 * mirrors `EvidenceMeta.trace` (src/receipt/types.ts), `actions`/`truncated`
 * are new top-level receipt fields (this task's spec, scope B item 3),
 * never nested under `evidence`: `evidence` names files on disk, `actions`
 * is data derived from one of them. All three are omitted, never present-
 * but-empty, matching every other optional receipt field's own convention. */
export interface TraceEvidence {
  readonly trace?: string;
  readonly actions?: readonly ActionEntry[];
  readonly truncated?: { readonly actions: number };
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_FIXED_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_FIXED_SIZE = 46;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
/** A zip's own comment field can run up to this many bytes, so the EOCD
 * signature cannot be assumed to sit at a fixed offset from the end of the
 * file — this bounds how far back `findEndOfCentralDirectory` searches. */
const MAX_ZIP_COMMENT_LENGTH = 65535;

/** Walks backward from the end of `buffer` for the end-of-central-directory
 * record's own signature — the entry point every other zip structure is
 * reached from (central directory, then each entry's own local header).
 * Throws when none is found; the caller (`readZipEntry`) is wrapped in a
 * try/catch that turns this, like any other malformed-zip failure, into
 * `{ kind: "unreadable" }` rather than a thrown exception reaching a step's
 * own receipt. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const searchFloor = Math.max(0, buffer.length - EOCD_FIXED_SIZE - MAX_ZIP_COMMENT_LENGTH);
  for (let offset = buffer.length - EOCD_FIXED_SIZE; offset >= searchFloor; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("not a zip file: no end-of-central-directory record found");
}

/** Reads one local file header + its (possibly deflated) data, decompressing
 * it when the central directory said `compressionMethod` was deflate (8,
 * the zip default) and returning it as-is when it said "stored" (0, no
 * compression) — `inflateRawSync` is the one decompression call this file
 * makes, per this task's spec (no new dependency). */
function readLocalFileEntry(
  buffer: Buffer,
  localHeaderOffset: number,
  compressionMethod: number,
  compressedSize: number,
): Buffer {
  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error("malformed zip: local file header signature mismatch");
  }
  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + LOCAL_FILE_HEADER_FIXED_SIZE + fileNameLength + extraFieldLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  return compressionMethod === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
}

/** Finds `entryName` in `buffer`'s own central directory and reads its data
 * (`readLocalFileEntry`). Returns `undefined` when no entry has that exact
 * name (never thrown — `trace.stacks`/`resources/*` simply not being
 * present, or already read past, is not this function's concern). Throws on
 * a structurally malformed zip; the caller catches it the same way
 * `findEndOfCentralDirectory`'s own throw is caught. */
function readZipEntry(buffer: Buffer, entryName: string): Buffer | undefined {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (offset < end) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("malformed zip: central directory signature mismatch");
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString(
      "utf8",
      offset + CENTRAL_DIRECTORY_HEADER_FIXED_SIZE,
      offset + CENTRAL_DIRECTORY_HEADER_FIXED_SIZE + fileNameLength,
    );

    if (fileName === entryName) {
      return readLocalFileEntry(buffer, localHeaderOffset, compressionMethod, compressedSize);
    }

    offset += CENTRAL_DIRECTORY_HEADER_FIXED_SIZE + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface TraceHeader {
  readonly version: number;
  readonly wallTime: number;
  readonly monotonicTime: number;
}

interface TraceBefore {
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly startTime: number;
}

interface TraceAfter {
  readonly endTime: number;
  readonly error?: unknown;
}

function readHeader(entry: Record<string, unknown>): TraceHeader | undefined {
  if (
    typeof entry.version === "number" &&
    typeof entry.wallTime === "number" &&
    typeof entry.monotonicTime === "number"
  ) {
    return { version: entry.version, wallTime: entry.wallTime, monotonicTime: entry.monotonicTime };
  }
  return undefined;
}

function readBefore(entry: Record<string, unknown>): TraceBefore | undefined {
  if (typeof entry.method === "string" && typeof entry.startTime === "number") {
    return {
      method: entry.method,
      ...(isRecord(entry.params) ? { params: entry.params } : {}),
      startTime: entry.startTime,
    };
  }
  return undefined;
}

function readAfter(entry: Record<string, unknown>): TraceAfter | undefined {
  if (typeof entry.endTime === "number") {
    return { endTime: entry.endTime, ...(entry.error !== undefined ? { error: entry.error } : {}) };
  }
  return undefined;
}

/** `before.params`, narrowed to the five keys a receipt is allowed to carry
 * (this task's spec, scope B item 3) — every other key (a `setContent`
 * call's own HTML body, for one) is dropped here, not merely left off the
 * `ActionEntry` type, so nothing beyond this list ever exists in memory as
 * part of a receipt-bound value. `timeout` on the trace side becomes
 * `timeout_ms` here, and `isNot` becomes `is_not`, matching the receipt's
 * own snake_case field convention (`http_reads`, `waited_ms`, ...). */
function allowedParams(
  params: Record<string, unknown> | undefined,
): Pick<ActionEntry, "expression" | "selector" | "url" | "is_not" | "timeout_ms"> {
  if (params === undefined) {
    return {};
  }
  return {
    ...(typeof params.expression === "string" ? { expression: params.expression } : {}),
    ...(typeof params.selector === "string" ? { selector: params.selector } : {}),
    ...(typeof params.url === "string" ? { url: params.url } : {}),
    ...(typeof params.isNot === "boolean" ? { is_not: params.isNot } : {}),
    ...(typeof params.timeout === "number" ? { timeout_ms: params.timeout } : {}),
  };
}

function buildActionEntry(before: TraceBefore, after: TraceAfter, header: TraceHeader): ActionEntry {
  const at = new Date(header.wallTime + (before.startTime - header.monotonicTime)).toISOString();
  return {
    method: before.method,
    ...allowedParams(before.params),
    ms: Math.round(after.endTime - before.startTime),
    outcome: after.error !== undefined ? "failed" : "passed",
    at,
  };
}

/** Parses `trace.trace`'s own newline-delimited JSON (this task's spec,
 * "前提") into `actions` — matching `before`/`after` entries by `callId`,
 * capping the result at `MAX_ACTIONS`, and refusing to guess at a trace
 * format version this build has never verified (`KNOWN_TRACE_VERSIONS`
 * above). Exported directly (rather than only through `collectTraceEvidence`
 * below) so a test can feed it a hand-built buffer without writing one to
 * disk first. */
export function parseTraceActions(traceTraceBuffer: Buffer): TraceActionsParseResult {
  let header: TraceHeader | undefined;
  const pendingBefores = new Map<string, TraceBefore>();
  const actions: ActionEntry[] = [];
  let totalActionCount = 0;

  const lines = traceTraceBuffer.toString("utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // One malformed line must not sink every other line's own data — this
      // file's own header, "measurement must never break execution" applied
      // at line granularity rather than only at the whole-file one.
      continue;
    }
    if (!isRecord(entry) || typeof entry.type !== "string") {
      continue;
    }

    if (entry.type === "context-options" && header === undefined) {
      header = readHeader(entry);
      continue;
    }
    if (entry.type === "before" && typeof entry.callId === "string") {
      const before = readBefore(entry);
      if (before !== undefined) {
        pendingBefores.set(entry.callId, before);
      }
      continue;
    }
    if (entry.type === "after" && typeof entry.callId === "string") {
      const before = pendingBefores.get(entry.callId);
      if (before === undefined) {
        continue;
      }
      pendingBefores.delete(entry.callId);
      const after = readAfter(entry);
      if (after === undefined || header === undefined) {
        continue;
      }
      totalActionCount += 1;
      if (actions.length < MAX_ACTIONS) {
        actions.push(buildActionEntry(before, after, header));
      }
    }
  }

  if (header === undefined) {
    // Never guessed at (this file's own header): a trace this file cannot
    // even confirm the version of is indistinguishable, on purpose, from
    // any other unreadable shape.
    return { kind: "unreadable" };
  }
  if (!KNOWN_TRACE_VERSIONS.includes(header.version)) {
    return { kind: "unknown-version", version: header.version };
  }
  return {
    kind: "ok",
    actions,
    ...(totalActionCount > MAX_ACTIONS ? { truncatedCount: totalActionCount } : {}),
  };
}

/** Reads `receiptDir/trace.zip` (when present) and turns it into this step's
 * own `trace`/`actions`/`truncated` receipt fields. Called only after the
 * file is known to already be fully written — create-context.ts's
 * `endStep()`/`dispose()` close a step's own trace chunk before its receipt
 * is ever built, exactly so this read never races that write. `undefined`
 * result fields, never thrown errors: a missing or unreadable trace.zip
 * costs `actions` (and `trace` itself, when the file plain doesn't exist),
 * never a step's own receipt (this file's own header). */
export async function collectTraceEvidence(
  receiptDir: string,
  onUnknownVersion: (version: number) => void,
): Promise<TraceEvidence> {
  const traceZipPath = path.join(receiptDir, "trace.zip");
  if (!existsSync(traceZipPath)) {
    return {};
  }
  try {
    const zipBuffer = await readFile(traceZipPath);
    const traceTraceBuffer = readZipEntry(zipBuffer, "trace.trace");
    if (traceTraceBuffer === undefined) {
      return { trace: "trace.zip" };
    }
    const result = parseTraceActions(traceTraceBuffer);
    if (result.kind === "ok") {
      return {
        trace: "trace.zip",
        ...(result.actions.length > 0 ? { actions: result.actions } : {}),
        ...(result.truncatedCount !== undefined ? { truncated: { actions: result.truncatedCount } } : {}),
      };
    }
    if (result.kind === "unknown-version") {
      onUnknownVersion(result.version);
    }
    return { trace: "trace.zip" };
  } catch {
    // Same "trace.zip exists, but nothing further could be read from it"
    // fallback as the `undefined` branch above — a corrupt zip, a read
    // error mid-file, or anything else this file did not specifically
    // anticipate.
    return { trace: "trace.zip" };
  }
}

function unknownTraceVersionWarning(version: number): string {
  return `warning: trace format version ${version} is not readable by this build; step actions were not recorded\n`;
}

/** Builds the "print this exactly once" stderr warning `collectTraceEvidence`
 * calls into when a trace's own header names a version this build does not
 * know how to read (this task's spec, scope B item 2) — one instance per
 * `nuka run`/`nuka do` invocation (created once by the caller, cli/run.ts or
 * cli/do.ts, and threaded through every scenario/step that invocation
 * executes), so a run that hits this on several steps still only ever
 * writes the line once, rather than once per occurrence. */
export function createTraceVersionWarner(stderr: WritableSink): (version: number) => void {
  let warned = false;
  return (version: number): void => {
    if (warned) {
      return;
    }
    warned = true;
    stderr.write(unknownTraceVersionWarning(version));
  };
}
