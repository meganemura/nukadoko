import { copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringifyEnvInfo, type Writer } from "allure-js-commons/sdk/reporter";
import type { Category, EnvironmentInfo } from "allure-js-commons/sdk";
import type { Globals, TestResult, TestResultContainer } from "allure-js-commons";

// Responsibility: a drop-in `Writer` (this task's spec, decision 10) that
// replaces allure-js-commons' own `FileSystemWriter`'s plain `writeFileSync`
// with temp+rename. `allure watch` polls its results directory every 300ms
// and reads each new file exactly once (design.md section 8/research notes
// section 6) — a half-written result.json read mid-write is read wrong
// forever, not just late, so this is the one place this task's spec
// deliberately does not "thinly pass through" the official SDK (design.md
// section 8's own words). Implements the bare `Writer` interface directly
// as a plain object (api-facts.md 1.3: `ReporterRuntimeConfig.writer`
// accepts one with no class inheritance) rather than extending or wrapping
// `FileSystemWriter` — mirrors its own per-method behavior (verified
// against `FileSystemWriter.js`) without reusing any of its code.
//
// Every temp name carries a leading dot and a `.tmp` marker (this task's
// spec, decision 10) so neither `allure watch`'s own `*-result.json`/
// `*-container.json`/`*-attachment.*` glob nor a human skimming the
// directory mistakes a half-written file for a finished one. The temp file
// is created in the same directory as its final name and renamed there
// (never across a different filesystem/mount), which is what makes the
// rename itself atomic.

function tempNameFor(finalName: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `.${finalName}.tmp-${process.pid}-${random}`;
}

function writeAtomic(filePath: string, data: Buffer | string): void {
  const tempPath = path.join(path.dirname(filePath), tempNameFor(path.basename(filePath)));
  writeFileSync(tempPath, data);
  renameSync(tempPath, filePath);
}

function copyAtomic(filePath: string, sourcePath: string): void {
  const tempPath = path.join(path.dirname(filePath), tempNameFor(path.basename(filePath)));
  copyFileSync(sourcePath, tempPath);
  renameSync(tempPath, filePath);
}

/** Builds a `Writer` rooted at `resultsDir`, creating it (and any missing
 * parents) up front. Existing files under `resultsDir` are never touched —
 * only added to (this task's spec, decision 10: "既存の allure-results を
 * 消さない"). */
export function createAtomicWriter(resultsDir: string): Writer {
  mkdirSync(resultsDir, { recursive: true });

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
      copyAtomic(resolve(distFileName), from);
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
