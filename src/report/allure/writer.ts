import { copyFileSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringifyEnvInfo, type Writer } from "allure-js-commons/sdk/reporter";
import type { Category, EnvironmentInfo } from "allure-js-commons/sdk";
import type { Globals, TestResult, TestResultContainer } from "allure-js-commons";

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
