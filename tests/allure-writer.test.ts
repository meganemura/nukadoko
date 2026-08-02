import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAtomicWriter } from "../src/report/allure/writer.js";

// Responsibility: exercises all seven Writer methods (this task's spec, test
// item 4) and asserts both halves of "atomic": the final file exists with
// the right content, and no `.tmp` leftover remains once the call returns.

function listNonTempFiles(dir: string): string[] {
  return readdirSync(dir).sort();
}

function assertNoTempFilesLeftOver(dir: string): void {
  const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
  expect(leftovers).toEqual([]);
}

describe("createAtomicWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-writer-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates resultsDir up front", () => {
    const resultsDir = path.join(dir, "allure-results");
    expect(existsSync(resultsDir)).toBe(false);
    createAtomicWriter(resultsDir);
    expect(existsSync(resultsDir)).toBe(true);
  });

  it("writeResult writes <uuid>-result.json with no temp file left behind", () => {
    const writer = createAtomicWriter(dir);
    writer.writeResult({ uuid: "abc", statusDetails: {}, stage: "pending" as never, steps: [], attachments: [], parameters: [], labels: [], links: [] } as never);
    const file = path.join(dir, "abc-result.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).uuid).toBe("abc");
    assertNoTempFilesLeftOver(dir);
  });

  it("writeGroup writes <uuid>-container.json with no temp file left behind", () => {
    const writer = createAtomicWriter(dir);
    writer.writeGroup({ uuid: "grp", children: [], befores: [], afters: [] });
    const file = path.join(dir, "grp-container.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).uuid).toBe("grp");
    assertNoTempFilesLeftOver(dir);
  });

  it("writeAttachment writes the given buffer under the given name with no temp file left behind", () => {
    const writer = createAtomicWriter(dir);
    writer.writeAttachment("att.txt", Buffer.from("hello", "utf8"));
    const file = path.join(dir, "att.txt");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("hello");
    assertNoTempFilesLeftOver(dir);
  });

  it("writeAttachmentFromPath copies the source file with no temp file left behind", () => {
    const source = path.join(dir, "source.txt");
    writeFileSync(source, "source content");
    const writer = createAtomicWriter(dir);
    writer.writeAttachmentFromPath("copied.txt", source);
    const file = path.join(dir, "copied.txt");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("source content");
    assertNoTempFilesLeftOver(dir);
  });

  it("writeEnvironmentInfo writes environment.properties via stringifyEnvInfo with no temp file left behind", () => {
    const writer = createAtomicWriter(dir);
    writer.writeEnvironmentInfo({ environment: "staging" });
    const file = path.join(dir, "environment.properties");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("environment=staging");
    assertNoTempFilesLeftOver(dir);
  });

  it("writeCategoriesDefinitions writes categories.json with no temp file left behind", () => {
    const writer = createAtomicWriter(dir);
    writer.writeCategoriesDefinitions([{ name: "a", matchedStatuses: [] }]);
    const file = path.join(dir, "categories.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ name: "a", matchedStatuses: [] }]);
    assertNoTempFilesLeftOver(dir);
  });

  it("writeGlobals writes the given file name with no temp file left behind", () => {
    const writer = createAtomicWriter(dir);
    writer.writeGlobals("g-globals.json", { attachments: [], errors: [] });
    const file = path.join(dir, "g-globals.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ attachments: [], errors: [] });
    assertNoTempFilesLeftOver(dir);
  });

  it("never removes files that were already there", () => {
    writeFileSync(path.join(dir, "pre-existing-result.json"), "{}");
    const writer = createAtomicWriter(dir);
    writer.writeResult({ uuid: "new", statusDetails: {}, stage: "pending" as never, steps: [], attachments: [], parameters: [], labels: [], links: [] } as never);
    expect(listNonTempFiles(dir)).toEqual(["new-result.json", "pre-existing-result.json"]);
  });
});
