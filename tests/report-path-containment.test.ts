import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { containedResolver } from "../src/report/load-run.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a run directory is untrusted input to nuka report. A path
// a record names is read only while it stays inside the run directory, or,
// for this project's own run, inside the project; an absolute path, a `..`
// path, and a symlink out are refused and named, and their file never
// reaches the output.

const SECRET = "the-secret-token-1234";

describe("containedResolver", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), "nukadoko-contain-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("keeps a path inside the run, and refuses an absolute path, a `..` path, and a symlink out", () => {
    const runDir = path.join(base, "copied", "run-1");
    writeFileSync(path.join(base, "secret.txt"), SECRET);
    cpSync(path.join(import.meta.dirname, "fixtures", "pure-step-project"), path.join(runDir, "steps", "s1"), { recursive: true });
    symlinkSync(path.join(base, "secret.txt"), path.join(runDir, "steps", "s1", "link.txt"));
    const resolve = containedResolver("run-1", runDir, path.join(base, "copied"), false);
    expect(resolve(".nukadoko/runs/run-1/steps/s1/nukadoko.config.ts")).toBe(path.join(runDir, "steps", "s1", "nukadoko.config.ts"));
    expect(() => resolve(path.join(base, "secret.txt"))).toThrow(`${path.join(base, "secret.txt")} resolves outside the run directory, so it is not read`);
    expect(() => resolve(".nukadoko/runs/run-1/steps/s1/../../../secret.txt")).toThrow("resolves outside the run directory");
    expect(() => resolve(".nukadoko/runs/run-1/steps/s1/link.txt")).toThrow("resolves outside the run directory");
    expect(() => resolve("features/x.feature")).toThrow("resolves outside the run directory");
  });

  it("lets this project's own run name a file in the project, and nothing outside it", () => {
    const rootDir = path.join(base, "project");
    const runDir = path.join(rootDir, ".nukadoko", "runs", "run-1");
    cpSync(path.join(import.meta.dirname, "fixtures", "pure-step-project"), rootDir, { recursive: true });
    writeFileSync(path.join(base, "secret.txt"), SECRET);
    const resolve = containedResolver("run-1", runDir, rootDir, true);
    expect(resolve("nukadoko.config.ts")).toBe(path.join(rootDir, "nukadoko.config.ts"));
    expect(() => resolve("../secret.txt")).toThrow("../secret.txt resolves outside the project, so it is not read");
  });
});

describe("nuka report on an edited run directory", () => {
  let rootDir: string;
  let outside: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
    outside = mkdtempSync(path.join(os.tmpdir(), "nukadoko-copied-run-"));
    writeFileSync(path.join(outside, "secret.txt"), SECRET);
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

  // A copy of the run, with its first step record declaring the given
  // attachment names under the given evidence directory.
  async function copiedRun(evidenceDir: (stepDir: string) => string, attachments: readonly string[], link = false): Promise<string> {
    expect((await cli(["run", "--no-check", "features/passing.feature"])).exitCode).toBe(0);
    const runId = latestRunJson(rootDir).run_id as string;
    const copy = path.join(outside, runId);
    cpSync(path.join(rootDir, ".nukadoko", "runs", runId), copy, { recursive: true });
    const [stepId] = readdirSync(path.join(copy, "steps")).sort();
    const stepDir = path.join(copy, "steps", stepId!);
    if (link) symlinkSync(path.join(outside, "secret.txt"), path.join(stepDir, "link.txt"));
    const recordPath = path.join(stepDir, "record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { evidence: { dir: string }; declared?: unknown };
    record.evidence.dir = evidenceDir(record.evidence.dir);
    record.declared = { attachments, logs: [] };
    writeFileSync(recordPath, JSON.stringify(record));
    return copy;
  }

  function everything(dir: string): string {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(path.join(entry.parentPath, entry.name)).toString("utf8") + readFileSync(path.join(entry.parentPath, entry.name)).toString("base64"))
      .join("\n");
  }

  const cases = [
    { name: "an absolute evidence directory", evidence: () => outside, attachments: ["secret.txt"], link: false },
    { name: "a `..` attachment", evidence: (dir: string) => dir, attachments: ["../../../secret.txt"], link: false },
    { name: "a symlink out", evidence: (dir: string) => dir, attachments: ["link.txt"], link: true },
  ];

  for (const { name, evidence, attachments, link } of cases) {
    it(`refuses ${name} in Allure results and the messages stream, and names it`, async () => {
      const copy = await copiedRun(evidence, attachments, link);
      const allureDir = path.join(outside, "allure");
      const allure = await cli(["report", copy, "--format", "allure", "--out", allureDir]);
      expect(allure.stderr).toMatch(/^warning\treport-incomplete\t-\tallure: could not attach .* resolves outside the run directory, so it is not read$/m);
      expect(everything(allureDir)).not.toContain(SECRET);
      expect(everything(allureDir)).not.toContain(Buffer.from(SECRET).toString("base64"));
      const messages = await cli(["report", copy, "--format", "messages"]);
      expect(messages.stderr).toMatch(/^warning\treport-incomplete\t-\tmessages: could not read attachment .* resolves outside the run directory, so it is not read$/m);
      expect(messages.stdout).not.toContain(Buffer.from(SECRET).toString("base64"));
      expect(messages.stdout).not.toContain(SECRET);
    });
  }
});
