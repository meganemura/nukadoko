import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Writer } from "allure-js-commons/sdk/reporter";
import type { TestResult, TestResultContainer } from "allure-js-commons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { stableNames, stableUuid } from "../src/report/allure/writer.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: rendering the same run again writes the same Allure file
// names, so a second render overwrites the first wherever it goes (into
// --out outside the state directory, or a copied run into the default
// directory), and this project's exports manifest holds each file once.
// Also the count nuka report prints: the results written, not the
// scenarios the run holds.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("stableUuid", () => {
  it("is a version 8 UUID, the same for the same key and index, and different for a different index", () =>
    hegel.test((tc) => {
      const key = tc.draw(gs.text({ maxSize: 40 }));
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: 1000 }));
      const other = tc.draw(gs.integers({ minValue: 0, maxValue: 1000 }));
      expect(stableUuid(key, index)).toMatch(UUID);
      expect(stableUuid(key, index)).toBe(stableUuid(key, index));
      if (other !== index) expect(stableUuid(key, other)).not.toBe(stableUuid(key, index));
    }));
});

describe("stableNames", () => {
  function recording(): { writer: Writer; names: string[]; results: TestResult[]; groups: TestResultContainer[] } {
    const names: string[] = [];
    const results: TestResult[] = [];
    const groups: TestResultContainer[] = [];
    const writer = {
      writeResult: (result: TestResult) => {
        names.push(`${result.uuid}-result.json`);
        results.push(result);
      },
      writeGroup: (group: TestResultContainer) => {
        names.push(`${group.uuid}-container.json`);
        groups.push(group);
      },
      writeAttachment: (name: string) => names.push(name),
      writeAttachmentFromPath: (name: string) => names.push(name),
      writeEnvironmentInfo: () => undefined,
      writeCategoriesDefinitions: () => undefined,
      writeGlobals: () => undefined,
    } as unknown as Writer;
    return { writer, names, results, groups };
  }

  // One scenario's writes in the order ReporterRuntime makes them, with
  // whatever random UUIDs it drew.
  function scenario(writer: ReturnType<typeof stableNames>, uuids: readonly string[], key: string): void {
    const [attachment, test, fixtureAttachment, scope] = uuids as [string, string, string, string];
    writer.begin(key);
    writer.writeAttachment(`${attachment}-attachment.json`, Buffer.from("{}"));
    writer.writeResult({
      uuid: test,
      attachments: [],
      steps: [{ attachments: [{ name: "a", type: "application/json", source: `${attachment}-attachment.json` }], steps: [] }],
      parameters: [{ name: "id", value: "3f1c2b4a-0000-4000-8000-000000000000" }],
    } as unknown as TestResult);
    writer.writeAttachmentFromPath(`${fixtureAttachment}-attachment.png`, "/x.png");
    writer.writeGroup({
      uuid: scope,
      children: [test],
      befores: [{ attachments: [{ name: "p", type: "image/png", source: `${fixtureAttachment}-attachment.png` }], steps: [] }],
      afters: [],
    } as unknown as TestResultContainer);
  }

  it("names the same scenario's files the same however the runtime drew its UUIDs, and keeps every link and the run's own data", () =>
    hegel.test((tc) => {
      const draw = (): string[] => Array.from({ length: 4 }, () => crypto.randomUUID());
      const key = tc.draw(gs.text({ maxSize: 20 }));
      const first = recording();
      scenario(stableNames(first.writer), draw(), key);
      const second = recording();
      scenario(stableNames(second.writer), draw(), key);
      expect(second.names).toEqual(first.names);
      const [result] = first.results;
      const [group] = first.groups;
      expect(first.names).toContain(result!.steps[0]!.attachments[0]!.source);
      expect(first.names).toContain(group!.befores[0]!.attachments[0]!.source);
      expect(group!.children).toEqual([result!.uuid]);
      expect(result!.parameters).toEqual([{ name: "id", value: "3f1c2b4a-0000-4000-8000-000000000000" }]);
    }));
});

describe("nuka report rendered twice", () => {
  let rootDir: string;
  let outside: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
    outside = mkdtempSync(path.join(os.tmpdir(), "nukadoko-rerender-"));
    expect((await cli(["run", "--no-check", "features/passing.feature"])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
    rmSync(outside, { recursive: true, force: true });
  });

  async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(args, { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  const runId = (): string => latestRunJson(rootDir).run_id as string;
  const results = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith("-result.json"));

  it("overwrites its own files in an --out directory outside the state directory", async () => {
    const out = path.join(outside, "allure");
    expect((await cli(["report", "--format", "allure", "--out", out])).exitCode).toBe(0);
    const first = readdirSync(out).sort();
    expect((await cli(["report", "--format", "allure", "--out", out])).exitCode).toBe(0);
    expect(readdirSync(out).sort()).toEqual(first);
    expect(results(out)).toHaveLength(1);
  });

  it("overwrites a copied run's files in the default directory", async () => {
    const copy = path.join(outside, runId());
    cpSync(path.join(rootDir, ".nukadoko", "runs", runId()), copy, { recursive: true });
    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    expect((await cli(["report", copy, "--format", "allure"])).exitCode).toBe(0);
    const first = readdirSync(resultsDir).sort();
    expect((await cli(["report", copy, "--format", "allure"])).exitCode).toBe(0);
    expect(readdirSync(resultsDir).sort()).toEqual(first);
    expect(results(resultsDir)).toHaveLength(1);
  });

  it("keeps each file once in this project's exports manifest", async () => {
    const manifest = path.join(rootDir, ".nukadoko", "runs", runId(), "exports");
    expect((await cli(["report", "--format", "allure"])).exitCode).toBe(0);
    const first = readFileSync(manifest, "utf8");
    expect((await cli(["report", "--format", "allure"])).exitCode).toBe(0);
    expect(readFileSync(manifest, "utf8")).toBe(first);
  });

  it("counts the results it wrote, not the scenarios the run holds", async () => {
    const out = path.join(outside, "allure");
    expect((await cli(["report", "--format", "allure", "--out", out])).exitCode).toBe(0);
    const [result] = results(out);
    rmSync(path.join(out, result!));
    mkdirSync(path.join(out, result!));
    const again = await cli(["report", "--format", "allure", "--out", out]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toMatch(/^failed\treport-incomplete\t-\tallure: scenario .* was not written: /m);
    expect(again.stderr.trimEnd().split("\n").at(-1)).toMatch(/^allure {4}\S+\/allure\/  0$/);
  });
});
