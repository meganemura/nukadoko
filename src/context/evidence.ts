import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceAttachmentEntry } from "../receipt/types.js";
import { InvalidEvidenceNameError } from "./errors.js";

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
// decides what's on the receipt" rule `evidence.http`/`evidence.trace`
// already follow (create-context.ts's own `dispose`).
//
// Collision-free naming: one registry backs
// both `attach` and `path`, so calling either twice with the same `name` —
// in any order — never reuses a file name; the first use keeps `name`
// as-is, every later use of the same base name gets `-2`, `-3`, ... inserted
// before the extension. Reset at every `beginStep` (create-context.ts), the
// same step-boundary lifetime every other collector already has: a name is
// unique only within the one step (or `nuka do` execution) that used it,
// never across a whole scenario.
//
// A name is refused, never sanitized, when it contains a path separator or
// is `.`/`..`/empty — see `InvalidEvidenceNameError`'s own doc comment
// (errors.ts) for why refusing was chosen over rewriting it.
//
// Capped at `MAX_ATTACHMENTS`, matching page-events.ts's/trace-actions.ts's
// own 100-entry cap and reported the same way, through the receipt's
// existing top-level `truncated` field (`mergeTruncated`, below) rather than
// a second, differently-shaped mechanism. Unlike those two collectors,
// nothing is discarded at record time to bound memory: every entry here is
// cheap metadata (a name/file/timestamp, never a body), so the whole set
// survives until `snapshot()`, which sorts by `at` and slices there — the
// *reported* 100 are always the earliest 100 by timestamp, not merely the
// first 100 by call order.

const MAX_ATTACHMENTS = 100;

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
}

export interface EvidenceCollector {
  /** `ctx.evidence.attach`: writes `body` to this step's own evidence
   * directory under a collision-free file name derived from `name`, then
   * records `{ name, file, at }` for `snapshot()` to report. Throws
   * `InvalidEvidenceNameError` for a `name` this file's own header rules
   * out. */
  attach(name: string, body: string | Uint8Array): Promise<void>;
  /** `ctx.evidence.path`: allocates a collision-free absolute path under
   * this step's own evidence directory, without writing anything —
   * Playwright's own `testInfo.outputPath()`. Synchronous: nothing here
   * touches the filesystem. Throws `InvalidEvidenceNameError` for the same
   * names `attach` refuses. */
  path(name: string): string;
  /** Executor-only: every attachment this step boundary produced, see
   * `EvidenceSnapshot`'s own doc comment. A `path()` call with no matching
   * write on disk by the time this runs contributes nothing (docs/spec.md
   * "Receipts": evidence lists only files that exist). */
  snapshot(): Promise<EvidenceSnapshot>;
  /** Executor-only: clears the name registry and every pending record at a
   * step boundary — same lifetime rule as `sections`/`polls`. */
  reset(): void;
}

function splitExtension(fileName: string): { readonly stem: string; readonly ext: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) {
    return { stem: fileName, ext: "" };
  }
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

function assertSafeEvidenceName(name: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new InvalidEvidenceNameError(name);
  }
}

export function createEvidenceCollector(dirOf: () => string): EvidenceCollector {
  let usedFileNames = new Set<string>();
  let attachEntries: EvidenceAttachmentEntry[] = [];
  let pathAllocations: { readonly name: string; readonly file: string }[] = [];

  function allocateFileName(name: string): string {
    assertSafeEvidenceName(name);
    if (!usedFileNames.has(name)) {
      usedFileNames.add(name);
      return name;
    }
    const { stem, ext } = splitExtension(name);
    let counter = 2;
    let candidate = `${stem}-${counter}${ext}`;
    while (usedFileNames.has(candidate)) {
      counter += 1;
      candidate = `${stem}-${counter}${ext}`;
    }
    usedFileNames.add(candidate);
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
          // book-keeping, decides what lands on the receipt).
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
      usedFileNames = new Set();
      attachEntries = [];
      pathAllocations = [];
    },
  };
}

/** Combines this collector's own truncation count with trace-actions.ts's
 * own `{ actions }` truncation record into the receipt's single top-level
 * `truncated` sibling field (`ReceiptBase.truncated`, src/receipt/types.ts)
 * — the same object `actions` alone used to be the only member of, now also
 * carrying `evidence` when this collector's own cap was hit too.
 * `undefined` when neither happened, so a caller spreads this in with the
 * same `...(truncated !== undefined ? { truncated } : {})` pattern every
 * other optional receipt field already uses (cli/do.ts, run/run-scenario.ts)
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
