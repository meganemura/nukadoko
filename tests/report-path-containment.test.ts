import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { containedResolver } from "../src/report/load-run.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a run directory is untrusted input to nuka report. A path
// a record names is read only while it stays inside the run directory,
// for a copied run and for this project's own run alike; an absolute path,
// a `..` path, a symlink out, and a file elsewhere in the project are
// refused and named, and their file never reaches the output.

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
    const resolve = containedResolver("run-1", runDir, path.join(base, "copied"));
    expect(resolve(".nukadoko/runs/run-1/steps/s1/nukadoko.config.ts")).toBe(path.join(runDir, "steps", "s1", "nukadoko.config.ts"));
    expect(() => resolve(path.join(base, "secret.txt"))).toThrow(`${path.join(base, "secret.txt")} resolves outside the run directory, so it is not read`);
    expect(() => resolve(".nukadoko/runs/run-1/steps/s1/../../../secret.txt")).toThrow("resolves outside the run directory");
    expect(() => resolve(".nukadoko/runs/run-1/steps/s1/link.txt")).toThrow("resolves outside the run directory");
    expect(() => resolve("features/x.feature")).toThrow("resolves outside the run directory");
  });

  it("refuses a file elsewhere in the project, as it does a file outside it", () => {
    const rootDir = path.join(base, "project");
    const runDir = path.join(rootDir, ".nukadoko", "runs", "run-1");
    cpSync(path.join(import.meta.dirname, "fixtures", "pure-step-project"), rootDir, { recursive: true });
    writeFileSync(path.join(base, "secret.txt"), SECRET);
    const resolve = containedResolver("run-1", runDir, rootDir);
    expect(() => resolve("nukadoko.config.ts")).toThrow("nukadoko.config.ts resolves outside the run directory, so it is not read");
    expect(() => resolve("../secret.txt")).toThrow("../secret.txt resolves outside the run directory, so it is not read");
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

  it("refuses a project file that this project's own run names, so `.env` never reaches the output", async () => {
    writeFileSync(path.join(rootDir, ".env"), `TOKEN=${SECRET}\n`);
    expect((await cli(["run", "--no-check", "features/passing.feature"])).exitCode).toBe(0);
    const runId = latestRunJson(rootDir).run_id as string;
    const runDir = path.join(rootDir, ".nukadoko", "runs", runId);
    const [stepId] = readdirSync(path.join(runDir, "steps")).sort();
    const recordPath = path.join(runDir, "steps", stepId!, "record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { evidence: { dir: string }; declared?: unknown };
    record.evidence.dir = ".";
    record.declared = { attachments: [".env"], logs: [] };
    writeFileSync(recordPath, JSON.stringify(record));
    const allureDir = path.join(outside, "allure");
    const allure = await cli(["report", "--format", "allure", "--out", allureDir]);
    expect(allure.exitCode).toBe(1);
    expect(allure.stderr).toMatch(/^failed\treport-incomplete\t-\tallure: could not attach \.\/\.env: \.\/\.env resolves outside the run directory, so it is not read$/m);
    expect(everything(allureDir)).not.toContain(SECRET);
    expect(everything(allureDir)).not.toContain(Buffer.from(`TOKEN=${SECRET}\n`).toString("base64"));
    const messages = await cli(["report", "--format", "messages"]);
    expect(messages.exitCode).toBe(1);
    expect(messages.stderr).toMatch(/^failed\treport-incomplete\t-\tmessages: could not read attachment \.\/\.env: \.\/\.env resolves outside the run directory, so it is not read$/m);
    expect(messages.stdout).not.toContain(Buffer.from(`TOKEN=${SECRET}\n`).toString("base64"));
  });

  it("refuses a record.json that is a symlink out of the run directory, and names it", async () => {
    const copy = await copiedRun((dir) => dir, []);
    const [stepId] = readdirSync(path.join(copy, "steps")).sort();
    const recordPath = path.join(copy, "steps", stepId!, "record.json");
    renameSync(recordPath, path.join(outside, "record.json"));
    symlinkSync(path.join(outside, "record.json"), recordPath);
    const allure = await cli(["report", copy, "--format", "allure", "--out", path.join(outside, "allure")]);
    expect(allure.exitCode).toBe(1);
    expect(allure.stderr).toMatch(
      new RegExp(`^failed\\treport-incomplete\\t-\\tscn-[a-z0-9-]+: steps/${stepId}/record\\.json resolves outside the run directory, so it is not read$`, "m"),
    );
  });

  it("leaves a file outside the run untouched when this project's exports manifest is a symlink to it", async () => {
    expect((await cli(["run", "--no-check", "features/passing.feature"])).exitCode).toBe(0);
    const runId = latestRunJson(rootDir).run_id as string;
    const victim = path.join(outside, "victim.txt");
    writeFileSync(victim, "keep\n");
    symlinkSync(victim, path.join(rootDir, ".nukadoko", "runs", runId, "exports"));
    const allure = await cli(["report", "--format", "allure"]);
    expect(allure.exitCode).toBe(1);
    expect(allure.stderr).toMatch(
      new RegExp(`^failed\\treport-incomplete\\t-\\texports of run ${runId} resolves outside the run directory, so this render is not noted in it$`, "m"),
    );
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
  });

  it("keeps a project file that this project's own exports manifest names through a symlinked directory under export/", async () => {
    expect((await cli(["run", "--no-check", "features/passing.feature"])).exitCode).toBe(0);
    const runId = latestRunJson(rootDir).run_id as string;
    writeFileSync(path.join(rootDir, "keep.txt"), "keep\n");
    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    mkdirSync(resultsDir, { recursive: true });
    symlinkSync(rootDir, path.join(resultsDir, "evil"));
    writeFileSync(path.join(rootDir, ".nukadoko", "runs", runId, "exports"), `${path.join(".nukadoko", "export", "allure-results", "evil", "keep.txt")}\n`);
    const allure = await cli(["report", "--format", "allure"]);
    expect(allure.exitCode).toBe(0);
    expect(readFileSync(path.join(rootDir, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("refuses a run directory under runs/ that is a symlink, and reads nothing through it", async () => {
    const copy = await copiedRun((stepDir) => stepDir, []);
    const linked = path.join(rootDir, ".nukadoko", "runs", "run-20261019-000000-link");
    symlinkSync(copy, linked);
    const relative = path.join(".nukadoko", "runs", "run-20261019-000000-link");
    for (const format of ["markdown", "allure", "messages"]) {
      const report = await cli(["report", relative, "--format", format, ...(format === "allure" ? ["--out", path.join(outside, "allure")] : [])]);
      expect(report.exitCode).toBe(2);
      expect(report.stdout).toBe("");
      expect(report.stderr).toBe(
        `refused\trun-invalid\t-\t${relative} is a symlink under ${path.join(".nukadoko", "runs")}, so it is not read: a run directory there is one nuka run wrote\n` +
          "  fix: Copy the run directory in instead of linking it, or name the directory the link points to.\n",
      );
    }
  });

  for (const { name, evidence, attachments, link } of cases) {
    it(`refuses ${name} in Allure results and the messages stream, and names it`, async () => {
      const copy = await copiedRun(evidence, attachments, link);
      const allureDir = path.join(outside, "allure");
      const allure = await cli(["report", copy, "--format", "allure", "--out", allureDir]);
      expect(allure.exitCode).toBe(1);
      expect(allure.stderr).toMatch(/^failed\treport-incomplete\t-\tallure: could not attach .* resolves outside the run directory, so it is not read$/m);
      expect(everything(allureDir)).not.toContain(SECRET);
      expect(everything(allureDir)).not.toContain(Buffer.from(SECRET).toString("base64"));
      const messages = await cli(["report", copy, "--format", "messages"]);
      expect(messages.exitCode).toBe(1);
      expect(messages.stderr).toMatch(/^failed\treport-incomplete\t-\tmessages: could not read attachment .* resolves outside the run directory, so it is not read$/m);
      expect(messages.stdout).not.toContain(Buffer.from(SECRET).toString("base64"));
      expect(messages.stdout).not.toContain(SECRET);
    });
  }
});
