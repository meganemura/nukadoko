import { copyFileSync, linkSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
// `writeProgressSnapshot`/`deleteProgressSnapshot`/`cleanProgressSnapshots`
// are the one exception to "existing files under `resultsDir` are never
// touched" above: a progress snapshot is emitter.ts's own scratch state
// (docs/spec.md's append-only promise is about `*-result.json`, the actual
// record, never about this tool's own disposable stand-in for one), so
// deleting one outright, mid-run or at the next run's own startup, is
// exactly the intended lifecycle rather than an exception to it.

function tempNameFor(finalName: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `.${finalName}.tmp-${process.pid}-${random}`;
}

function writeAtomic(filePath: string, data: Buffer | string): void {
  const tempPath = path.join(path.dirname(filePath), tempNameFor(path.basename(filePath)));
  writeFileSync(tempPath, data);
  renameSync(tempPath, filePath);
}

// An attachment that already exists as a file (a step's own trace.zip or
// screenshot under `records/steps/<id>/`) is hard-linked into `resultsDir`
// rather than copied. The two directories otherwise hold every byte of
// every trace twice: measured on a project that ran 202 times in four days,
// 9.0 GB of trace zips under `records/` and the same 9.0 GB again under
// `allure-results/`. A hard link costs one directory entry, reads
// identically to a copy from Allure's side (it opens the file by name and
// never writes to it), and outlives `nuka clean --records` removing the
// original, since the link count, not the original path, keeps the bytes
// alive. The link is made to the temp name and then renamed, so the
// atomicity the header describes holds for links exactly as for writes.
// Linking fails across filesystems (`allure.resultsDir` can point anywhere)
// and on filesystems without hard links, so any link failure falls back to
// a copy of the same bytes; the outcome differs only in disk usage.
function linkOrCopyAtomic(filePath: string, sourcePath: string, link: LinkFile): void {
  const tempPath = path.join(path.dirname(filePath), tempNameFor(path.basename(filePath)));
  try {
    link(sourcePath, tempPath);
  } catch {
    copyFileSync(sourcePath, tempPath);
  }
  renameSync(tempPath, filePath);
}

/** `linkSync`'s own shape, injectable so a test can force the copy
 * fallback without needing a second filesystem. */
export type LinkFile = (existingPath: string, newPath: string) => void;

export interface AtomicWriterOptions {
  /** Defaults to `linkSync`. */
  readonly link?: LinkFile;
}

// A progress snapshot's own filename always ends in this — nested inside
// `writeResult`'s own `-result.json` suffix (`allure watch`'s own glob
// reads both alike, this file's own header) but with the extra `-progress`
// marker that lets `cleanProgressSnapshots` (and a human skimming the
// directory) tell one apart from a real, finished result sharing the same
// directory.
const PROGRESS_SUFFIX = "-progress-result.json";

function progressFileName(uuid: string, sequence: number): string {
  return `${uuid}-${sequence}${PROGRESS_SUFFIX}`;
}

/** `createAtomicWriter`'s own return type — the bare `Writer` interface
 * `ReporterRuntime` itself is built against, plus the three progress-
 * snapshot operations only emitter.ts's own progress mechanism calls.
 * `ReporterRuntime` never sees these three: they exist because a progress
 * snapshot is written directly, bypassing `ReporterRuntime` entirely (this
 * file's own header, emitter.ts's own header explains why).
 *
 * `writeProgressSnapshot`/`deleteProgressSnapshot` take a `sequence` number
 * because a scenario's own snapshots all carry the same `uuid` (a fixed
 * `uuid` is what keeps `allure watch`'s detail page on one route for the
 * whole scenario, since that route is `md5(uuid)`) while still needing a
 * fresh file name on every write (`allure watch` only ever discovers a path
 * it has not read before, so overwriting one name in place would go
 * unnoticed after the first write). `sequence` is what tells two snapshots
 * with the same `uuid` apart on disk. */
export interface AllureAtomicWriter extends Writer {
  /** Atomically writes one progress snapshot under
   * `<result.uuid>-<sequence>-progress-result.json`, never `writeResult`'s
   * own `<uuid>-result.json`, so a real, finished result and a still-
   * updating snapshot can never collide on one filename even while sharing
   * a `uuid`-shaped prefix. */
  writeProgressSnapshot(result: TestResult, sequence: number): void;
  /** Deletes one scenario's own progress snapshot by the `uuid` and
   * `sequence` it was written under. Silent when the file is already gone
   * (a repeated cleanup, or a `uuid`/`sequence` pair this writer never
   * actually wrote a snapshot for). There is nothing left to warn about
   * once the file this call wanted removed already does not exist. */
  deleteProgressSnapshot(uuid: string, sequence: number): void;
  /** Deletes every `*-progress-result.json` file already sitting in
   * `resultsDir` — called once, at `nuka run`'s own startup (emitter.ts's
   * own `begin()`), the same moment categories.json/environment.properties
   * get (re)written. A progress file is this tool's own scratch state
   * (this file's own header, just above), so a previous run's
   * crash-abandoned one is safe to remove outright rather than merely
   * superseded the way a real result would need to be. */
  cleanProgressSnapshots(): void;
}

/** Builds a `Writer` rooted at `resultsDir`, creating it (and any missing
 * parents) up front. Existing `*-result.json`/`*-container.json`/etc. files
 * under `resultsDir` are never touched — only added to (never delete an
 * existing allure-results directory); a `*-progress-result.json` file is
 * the one exception (this file's own header). */
export function createAtomicWriter(resultsDir: string, options: AtomicWriterOptions = {}): AllureAtomicWriter {
  mkdirSync(resultsDir, { recursive: true });
  const link: LinkFile = options.link ?? linkSync;

  const resolve = (name: string): string => path.join(resultsDir, name);

  return {
    writeResult(result: TestResult): void {
      writeAtomic(resolve(`${result.uuid}-result.json`), JSON.stringify(result));
    },
    writeGroup(result: TestResultContainer): void {
      writeAtomic(resolve(`${result.uuid}-container.json`), JSON.stringify(result));
    },
    writeAttachment(distFileName: string, content: Buffer): void {
      writeAtomic(resolve(distFileName), content);
    },
    writeAttachmentFromPath(distFileName: string, from: string): void {
      linkOrCopyAtomic(resolve(distFileName), from, link);
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
    writeProgressSnapshot(result: TestResult, sequence: number): void {
      writeAtomic(resolve(progressFileName(result.uuid, sequence)), JSON.stringify(result));
    },
    deleteProgressSnapshot(uuid: string, sequence: number): void {
      try {
        unlinkSync(resolve(progressFileName(uuid, sequence)));
      } catch {
        // Already gone -- nothing left to clean up.
      }
    },
    cleanProgressSnapshots(): void {
      for (const name of readdirSync(resultsDir)) {
        if (name.endsWith(PROGRESS_SUFFIX)) {
          unlinkSync(resolve(name));
        }
      }
    },
  };
}
