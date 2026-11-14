import { createHash } from "node:crypto";
import { copyFileSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringifyEnvInfo, type Writer } from "allure-js-commons/sdk/reporter";
import type { Category, EnvironmentInfo } from "allure-js-commons/sdk";
import type { Attachment, FixtureResult, Globals, StepResult, TestResult, TestResultContainer } from "allure-js-commons";

// Responsibility: a drop-in `Writer` that replaces allure-js-commons' own
// `FileSystemWriter`'s plain `writeFileSync`
// with temp+rename. `allure watch` polls its results directory every 300ms
// and reads each new file exactly once — a half-written result.json read
// mid-write is read wrong forever, not just late, so this is the one place
// this module deliberately does not "thinly pass through" the official
// SDK. Implements the bare `Writer` interface directly as a plain object
// (verified against allure-js-commons' own exports: `ReporterRuntimeConfig
// .writer` accepts one with no class inheritance) rather than extending or
// wrapping `FileSystemWriter` — mirrors its own per-method behavior
// (verified against `FileSystemWriter.js`) without reusing any of its code.
//
// Every temp name carries a leading dot and a `.tmp` marker so neither
// `allure watch`'s own `*-result.json`/`*-container.json`/`*-attachment.*`
// glob nor a human skimming the
// directory mistakes a half-written file for a finished one. The temp file
// is created in the same directory as its final name and renamed there
// (never across a different filesystem/mount), which is what makes the
// rename itself atomic.
//
// `allure watch` is still why this matters after a run: `nuka report
// --format allure` can write into a directory a running `allure watch`
// already reads.

function tempNameFor(finalName: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `.${finalName}.tmp-${process.pid}-${random}`;
}

/** Runs `fill` on a fresh temp path beside `filePath`, then renames the temp
 * file onto `filePath`. A failure in either step removes the temp file and
 * rethrows, so a failed write leaves nothing a later run has to clean. */
function replaceAtomic(filePath: string, fill: (tempPath: string) => void): void {
  const tempPath = path.join(path.dirname(filePath), tempNameFor(path.basename(filePath)));
  try {
    fill(tempPath);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function writeAtomic(filePath: string, data: Buffer | string): void {
  replaceAtomic(filePath, (tempPath) => writeFileSync(tempPath, data));
}

// An attachment that already exists as a file (a step's own trace.zip or
// screenshot under a run's `steps/<id>/`) is hard-linked into `resultsDir`
// rather than copied. The two directories otherwise hold every byte of
// every trace twice: measured on a project that ran 202 times in four days,
// 9.0 GB of trace zips among the records and the same 9.0 GB again under
// `allure-results/`. A hard link costs one directory entry, reads
// identically to a copy from Allure's side (it opens the file by name and
// never writes to it), and outlives `nuka clean` removing the
// original, since the link count, not the original path, keeps the bytes
// alive. The link is made to the temp name and then renamed, so the
// atomicity the header describes holds for links exactly as for writes.
// Linking fails across filesystems (`nuka report --out` can point anywhere)
// and on filesystems without hard links, so any link failure falls back to
// a copy of the same bytes; the outcome differs only in disk usage.
function linkOrCopyAtomic(filePath: string, sourcePath: string, link: LinkFile): void {
  replaceAtomic(filePath, (tempPath) => {
    try {
      link(sourcePath, tempPath);
    } catch {
      copyFileSync(sourcePath, tempPath);
    }
  });
}

/** `linkSync`'s own shape, injectable so a test can force the copy
 * fallback without needing a second filesystem. */
export type LinkFile = (existingPath: string, newPath: string) => void;

export interface AtomicWriterOptions {
  /** Defaults to `linkSync`. */
  readonly link?: LinkFile;
  /** Called with the absolute path of every result, container, and
   * attachment file this writer completes (after the rename, so the path
   * names a finished file). Never called for `environment.properties`,
   * `categories.json`, or a globals file: those are rewritten by every
   * report and belong to no one run. This is what lets one run own its
   * export files (src/record/run-exports.ts). */
  readonly onWrite?: (absolutePath: string) => void;
}

/** Builds a `Writer` rooted at `resultsDir`, creating it (and any missing
 * parents) up front. Existing `*-result.json`/`*-container.json`/etc. files
 * under `resultsDir` are never touched by the writer: only added to. */
export function createAtomicWriter(resultsDir: string, options: AtomicWriterOptions = {}): Writer {
  mkdirSync(resultsDir, { recursive: true });
  const link: LinkFile = options.link ?? linkSync;

  const resolve = (name: string): string => path.join(resultsDir, name);
  const noteWritten = (filePath: string): void => {
    options.onWrite?.(filePath);
  };

  return {
    writeResult(result: TestResult): void {
      const filePath = resolve(`${result.uuid}-result.json`);
      writeAtomic(filePath, JSON.stringify(result));
      noteWritten(filePath);
    },
    writeGroup(result: TestResultContainer): void {
      const filePath = resolve(`${result.uuid}-container.json`);
      writeAtomic(filePath, JSON.stringify(result));
      noteWritten(filePath);
    },
    writeAttachment(distFileName: string, content: Buffer): void {
      const filePath = resolve(distFileName);
      writeAtomic(filePath, content);
      noteWritten(filePath);
    },
    writeAttachmentFromPath(distFileName: string, from: string): void {
      const filePath = resolve(distFileName);
      linkOrCopyAtomic(filePath, from, link);
      noteWritten(filePath);
    },
    writeEnvironmentInfo(info: EnvironmentInfo): void {
      // Mirrors FileSystemWriter.writeEnvironmentInfo exactly (verified in
      // FileSystemWriter.js): the same `stringifyEnvInfo` call, just an
      // atomic write instead of a direct one.
      writeAtomic(resolve("environment.properties"), stringifyEnvInfo(info));
    },
    writeCategoriesDefinitions(categories: Category[]): void {
      writeAtomic(resolve("categories.json"), JSON.stringify(categories));
    },
    writeGlobals(distFileName: string, info: Globals): void {
      writeAtomic(resolve(distFileName), JSON.stringify(info));
    },
  };
}

// --- stable names ---
//
// allure-js-commons names every result, container, and attachment with a
// random UUID it draws inside `ReporterRuntime`, so a second render of the
// same run wrote a second copy of every file beside the first, and Allure
// showed each scenario twice. The writer is the one place every name
// passes through, so it renames them here: each random UUID becomes one
// derived from a key the caller names per scenario (the run id, the
// scenario record id, and the environment) and the order in which the
// UUID first appeared. The same run renders the same calls in the same
// order, so a second render writes the same names and overwrites the
// first. The alternative refused: generating our own UUIDs by replacing
// `ReporterRuntime`, which would mean copying the runtime's own logic for
// fixtures, steps, and identity.

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** A UUID-shaped name from `key` and `index`: the first 16 bytes of their
 * SHA-256, with the version 8 (custom) and RFC 9562 variant bits set. Pure. */
export function stableUuid(key: string, index: number): string {
  const bytes = createHash("sha256").update(`${key}\u0000${index}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface StableWriter extends Writer {
  /** Starts the names of one scenario: every file written until the next
   * call is named from `key`. */
  begin(key: string): void;
}

/** Wraps `inner` so every result, container, and attachment name is
 * derived from the key of the scenario being written (`begin`) instead of
 * the random UUID allure-js-commons chose. */
export function stableNames(inner: Writer): StableWriter {
  let key = "";
  let names = new Map<string, string>();
  const rename = (uuid: string): string => {
    let stable = names.get(uuid);
    if (stable === undefined) {
      stable = stableUuid(key, names.size);
      names.set(uuid, stable);
    }
    return stable;
  };
  const renameFile = (fileName: string): string => {
    const match = UUID_PREFIX.exec(fileName);
    return match === null ? fileName : `${rename(match[0])}${fileName.slice(match[0].length)}`;
  };
  // Only a source this writer renamed is rewritten; anything else in a
  // result is the run's own data and stays as it is.
  const renameAttachments = (attachments: readonly Attachment[]): Attachment[] =>
    attachments.map((attachment) => {
      const match = UUID_PREFIX.exec(attachment.source);
      return match !== null && names.has(match[0]) ? { ...attachment, source: renameFile(attachment.source) } : attachment;
    });
  const renameSteps = (steps: readonly StepResult[]): StepResult[] =>
    steps.map((step) => ({ ...step, attachments: renameAttachments(step.attachments), steps: renameSteps(step.steps) }));
  const renameFixtures = (fixtures: readonly FixtureResult[]): FixtureResult[] =>
    fixtures.map((fixture) => ({ ...fixture, attachments: renameAttachments(fixture.attachments), steps: renameSteps(fixture.steps) }));

  return {
    begin(next: string): void {
      key = next;
      names = new Map();
    },
    writeResult(result: TestResult): void {
      inner.writeResult({ ...result, uuid: rename(result.uuid), attachments: renameAttachments(result.attachments), steps: renameSteps(result.steps) });
    },
    writeGroup(result: TestResultContainer): void {
      inner.writeGroup({
        ...result,
        uuid: rename(result.uuid),
        children: result.children.map(rename),
        befores: renameFixtures(result.befores),
        afters: renameFixtures(result.afters),
      });
    },
    writeAttachment(distFileName: string, content: Buffer): void {
      inner.writeAttachment(renameFile(distFileName), content);
    },
    writeAttachmentFromPath(distFileName: string, from: string): void {
      inner.writeAttachmentFromPath(renameFile(distFileName), from);
    },
    writeEnvironmentInfo: (info) => inner.writeEnvironmentInfo(info),
    writeCategoriesDefinitions: (categories) => inner.writeCategoriesDefinitions(categories),
    writeGlobals: (distFileName, info) => inner.writeGlobals(distFileName, info),
  };
}
