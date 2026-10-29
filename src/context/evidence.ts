import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceAttachmentEntry, EvidenceMeta } from "../record/types.js";
import { isNamedContextHarnessFile } from "./context-name.js";
import { InvalidEvidenceNameError, ReservedEvidenceNameError } from "./errors.js";
import { PROGRAM_LOG_LATE_FILE_NAME, PROGRAM_LOG_SLICE_FILE_NAME } from "./program-log-slice.js";
import { isProcessOutputFileName } from "./process-output.js";

// Responsibility: `ctx.evidence`'s own `attach`/`path` — the
// step-facing counterpart to Playwright's `testInfo.attach()`/
// `outputPath()`, shaped to nukadoko's own trust model rather than copying
// theirs. The evidence *directory* stays executor-only knowledge (docs/
// spec.md "Context API": "ctx carries only what the executor must inject");
// `dirOf` mirrors http-log.ts's own `logPath: () => string` getter so
// create-context.ts can redirect where the *next* attach()/path() call lands
// at each `beginStep` boundary, the exact same mechanism http.jsonl already
// moves through — this module never learns the directory itself, only reads
// whatever the executor's getter currently returns.
//
// `attach(name, body)` writes immediately and records `{ name, file, at }`
// right away: the write already happened, so there is nothing left to
// confirm later. `path(name)` only allocates a collision-free name and
// returns the absolute path a step could write to — nothing is written here,
// and nothing is recorded here either; only `snapshot()` (executor-only,
// called once this execution/step is finished) confirms which allocated
// paths actually have a file on disk, the same "existence, not book-keeping,
// decides what's on the step record" rule `evidence.http`/`evidence.trace`
// already follow (create-context.ts's own `dispose`).
//
// Collision-free naming: one registry backs
// both `attach` and `path`, so calling either twice with the same `name` —
// in any order — never reuses a file name; the first use keeps `name`
// as-is, every later use of the same base name gets `-2`, `-3`, ... inserted
// before the extension. The registry key is `toLowerCase` (locale-independent
// Unicode default case mapping, not the process locale): two names that
// differ only by case are one file on a case-insensitive volume, so the
// second use is suffixed the same way. Reset at every `beginStep`
// (create-context.ts), the same step-boundary lifetime every other collector
// already has: a name is unique only within the one step (or `nuka do`
// execution) that used it, never across a whole scenario. The reset keeps
// the harness file names seeded, so a later step still cannot replace them.
//
// Those harness files (`record.json`, `final.png`, `trace.zip`,
// `http.jsonl`, and the step's lines of the program's log,
// `program-log.txt` and `program-log-late.txt`) are refused up front,
// including a spelling that differs only by case
// (`ReservedEvidenceNameError`). A suffixed copy would not be
// the name the step asked for, and writing the name as given would replace
// the file the harness writes in this directory. A `pageAs(name)` context
// writes `trace.<name>.zip` and `final.<name>.png` beside them, so those
// shapes are refused for every valid context name, opened or not: whether
// a later step opens one is not known when this step attaches. A caller
// can reserve more: `nuka do` keeps its world's directory, `world`, in
// the same directory.
//
// A name is refused, never sanitized, when it contains a path separator or
// is `.`/`..`/empty — see `InvalidEvidenceNameError`'s own doc comment
// (errors.ts) for why refusing was chosen over rewriting it.
//
// Capped at `MAX_ATTACHMENTS`, matching page-events.ts's/trace-actions.ts's
// own 100-entry cap and reported the same way, through the step record's
// existing top-level `truncated` field (`mergeTruncated`, below) rather than
// a second, differently-shaped mechanism. Unlike those two collectors,
// nothing is discarded at record time to bound memory: every entry here is
// cheap metadata (a name/file/timestamp, never a body), so the whole set
// survives until `snapshot()`, which sorts by `at` and slices there — the
// *reported* 100 are always the earliest 100 by timestamp, not merely the
// first 100 by call order.

const MAX_ATTACHMENTS = 100;

/** Files the harness writes into the same directory `attach`/`path` use.
 * Seeded into the name registry, and refused when a step asks for one,
 * including a spelling that differs only by case. */
const HARNESS_EVIDENCE_FILE_NAMES = [
  "record.json",
  "final.png",
  "trace.zip",
  "requests.zip",
  "http.jsonl",
  PROGRAM_LOG_SLICE_FILE_NAME,
  PROGRAM_LOG_LATE_FILE_NAME,
] as const;

/** Registry key. `toLowerCase` is the locale-independent Unicode default
 * mapping. A case-insensitive volume treats that result as one file. The
 * process locale's `toLocaleLowerCase` would not: under Turkish it maps
 * "I" to "ı", so "I" and "i" would miss a collision those volumes still have. */
function evidenceNameKey(name: string): string {
  return name.toLowerCase();
}

function createUsedFileNames(reserved: readonly string[]): Set<string> {
  return new Set([...HARNESS_EVIDENCE_FILE_NAMES, ...reserved].map((name) => evidenceNameKey(name)));
}

export interface EvidenceSnapshot {
  /** Every attachment this step boundary produced, sorted by `at` ascending
   * and capped at `MAX_ATTACHMENTS`. */
  readonly attachments: readonly EvidenceAttachmentEntry[];
  /** The true total this step boundary recorded — `attach()`'s own writes
   * plus every `path()`-allocated file confirmed to exist — present only
   * once it exceeds `MAX_ATTACHMENTS` (same "present only when the cap was
   * actually hit" convention `page_events.truncated`/`traceEvidence.
   * truncated` already follow). */
  readonly truncatedCount?: number;
  /** The `scratch` directories this step boundary created. The evidence
   * collector does not own them, so its own `snapshot()` leaves this out;
   * the context handle's `evidenceSnapshot()` adds it. */
  readonly scratch?: readonly string[];
}

export interface EvidenceCollector {
  /** `ctx.evidence.attach`: writes `body` to this step's own evidence
   * directory under a collision-free file name derived from `name`, then
   * records `{ name, file, at }` for `snapshot()` to report. Throws
   * `InvalidEvidenceNameError` for a `name` this file's own header rules
   * out, and `ReservedEvidenceNameError` for a harness file name. */
  attach(name: string, body: string | Uint8Array): Promise<void>;
  /** `ctx.evidence.path`: allocates a collision-free absolute path under
   * this step's own evidence directory, without writing anything —
   * Playwright's own `testInfo.outputPath()`. Synchronous: nothing here
   * touches the filesystem. Throws `InvalidEvidenceNameError` or
   * `ReservedEvidenceNameError` for the same names `attach` refuses. */
  path(name: string): string;
  /** Executor-only: every attachment this step boundary produced, see
   * `EvidenceSnapshot`'s own doc comment. A `path()` call with no matching
   * write on disk by the time this runs contributes nothing (docs/spec.md
   * "Records": evidence lists only files that exist). */
  snapshot(): Promise<EvidenceSnapshot>;
  /** Executor-only: drops step-allocated names and every pending record at a
   * step boundary, same lifetime rule as `sections`/`polls`. The harness
   * file names stay seeded (this file's own header). */
  reset(): void;
}

function splitExtension(fileName: string): { readonly stem: string; readonly ext: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) {
    return { stem: fileName, ext: "" };
  }
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

function assertSafeEvidenceName(name: string, reservedNames: readonly string[]): void {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new InvalidEvidenceNameError(name);
  }
  const key = evidenceNameKey(name);
  if (
    [...HARNESS_EVIDENCE_FILE_NAMES, ...reservedNames].some((reserved) => evidenceNameKey(reserved) === key) ||
    isNamedContextHarnessFile(name) ||
    isProcessOutputFileName(name)
  ) {
    throw new ReservedEvidenceNameError(name);
  }
}

/** `reserved` adds names the caller keeps in the same directory (this
 * file's header). */
export function createEvidenceCollector(dirOf: () => string, reserved: readonly string[] = []): EvidenceCollector {
  let usedFileNames = createUsedFileNames(reserved);
  let attachEntries: EvidenceAttachmentEntry[] = [];
  let pathAllocations: { readonly name: string; readonly file: string }[] = [];

  function allocateFileName(name: string): string {
    assertSafeEvidenceName(name, reserved);
    const key = evidenceNameKey(name);
    if (!usedFileNames.has(key)) {
      usedFileNames.add(key);
      return name;
    }
    const { stem, ext } = splitExtension(name);
    let counter = 2;
    let candidate = `${stem}-${counter}${ext}`;
    while (usedFileNames.has(evidenceNameKey(candidate))) {
      counter += 1;
      candidate = `${stem}-${counter}${ext}`;
    }
    usedFileNames.add(evidenceNameKey(candidate));
    return candidate;
  }

  return {
    async attach(name: string, body: string | Uint8Array): Promise<void> {
      const file = allocateFileName(name);
      await writeFile(path.join(dirOf(), file), body);
      attachEntries.push({ name, file, at: new Date().toISOString() });
    },
    path(name: string): string {
      const file = allocateFileName(name);
      pathAllocations.push({ name, file });
      return path.join(dirOf(), file);
    },
    async snapshot(): Promise<EvidenceSnapshot> {
      const dir = dirOf();
      const resolvedFromPath: EvidenceAttachmentEntry[] = [];
      for (const { name, file } of pathAllocations) {
        const absolutePath = path.join(dir, file);
        if (!existsSync(absolutePath)) {
          continue;
        }
        try {
          const stats = await stat(absolutePath);
          resolvedFromPath.push({ name, file, at: stats.mtime.toISOString() });
        } catch {
          // Raced away between existsSync and stat — treated the same as
          // never written (this file's own header: existence, not
          // book-keeping, decides what lands on the step record).
        }
      }
      const merged = [...attachEntries, ...resolvedFromPath].sort((a, b) =>
        a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
      );
      const total = merged.length;
      return {
        attachments: merged.slice(0, MAX_ATTACHMENTS),
        ...(total > MAX_ATTACHMENTS ? { truncatedCount: total } : {}),
      };
    },
    reset(): void {
      usedFileNames = createUsedFileNames(reserved);
      attachEntries = [];
      pathAllocations = [];
    },
  };
}

/** Combines this collector's own truncation count with trace-actions.ts's
 * own `{ actions }` truncation record into the step record's single top-level
 * `truncated` sibling field (`StepRecordBase.truncated`, src/record/types.ts)
 * — the same object `actions` alone used to be the only member of, now also
 * carrying `evidence` when this collector's own cap was hit too.
 * `undefined` when neither happened, so a caller spreads this in with the
 * same `...(truncated !== undefined ? { truncated } : {})` pattern every
 * other optional step record field already uses (cli/do.ts, run/run-scenario.ts)
 * — one function, so the two executors can never combine the two sources
 * differently from each other. */
export function mergeTruncated(
  actionsTruncated: { readonly actions: number } | undefined,
  evidenceTruncatedCount: number | undefined,
): { actions?: number; evidence?: number } | undefined {
  const merged: { actions?: number; evidence?: number } = {};
  if (actionsTruncated !== undefined) {
    merged.actions = actionsTruncated.actions;
  }
  if (evidenceTruncatedCount !== undefined) {
    merged.evidence = evidenceTruncatedCount;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The optional `EvidenceMeta` fields a step boundary's snapshot fills, each
 * present only when non-empty. One function, so every executor that writes
 * a step record (`nuka run`, `nuka do`) adds
 * the same fields the same way. */
export function evidenceMetaFields(snapshot: EvidenceSnapshot): Pick<EvidenceMeta, "attachments" | "scratch"> {
  return {
    ...(snapshot.attachments.length > 0 ? { attachments: snapshot.attachments } : {}),
    ...(snapshot.scratch !== undefined && snapshot.scratch.length > 0 ? { scratch: snapshot.scratch } : {}),
  };
}
