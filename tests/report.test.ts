import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir, withoutNoConfigLine } from "./helpers/fixtures.js";

// Responsibility: `nuka report` end to end, on run directories a real
// `nuka run` wrote: where each format goes, the refusals, that a run
// writes no export output of its own, and that a run directory copied out
// of its project still renders with the same Allure identity. The mapping
// itself (labels, parameters, attachments, identity) is covered by
// tests/allure-write-results.test.ts and tests/messages-write-stream.test.ts.

function resultFiles(resultsDir: string): string[] {
  return readdirSync(resultsDir).filter((name) => name.endsWith("-result.json"));
}

function readResult(resultsDir: string, fileName: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(resultsDir, fileName), "utf8")) as Record<string, unknown>;
}

function historyIds(resultsDir: string): unknown[] {
  return resultFiles(resultsDir).map((name) => readResult(resultsDir, name).historyId);
}

describe("nuka report", () => {
  let rootDir: string;
  const resultsDir = (): string => path.join(rootDir, ".nukadoko", "export", "allure-results");

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(args, { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  async function run(feature = "features/passing.feature"): Promise<string> {
    expect((await cli(["run", "--no-check", feature])).exitCode).toBe(0);
    return latestRunJson(rootDir).run_id as string;
  }

  it("refuses with run-not-found when no run ended yet", async () => {
    expect(await cli(["report", "--format", "markdown"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "refused\trun-not-found\t-\tno run under .nukadoko/runs has a run.json\n  fix: Name a run directory that holds a run.json, or run nuka run first.\n  do: nuka run\n",
    });
  });

  it("leaves the export directory alone during a run", async () => {
    await run();
    expect(existsSync(path.join(rootDir, ".nukadoko", "export"))).toBe(false);
  });

  it("prints the newest run's summary on stdout, the same text the run wrote to summary.md", async () => {
    const runId = await run();
    const result = await cli(["report", "--format", "markdown"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(readFileSync(path.join(rootDir, ".nukadoko", "runs", runId, "summary.md"), "utf8"));
  });

  it("writes the summary to --out and names the path on stderr", async () => {
    const runId = await run();
    expect(await cli(["report", "--format", "markdown", "--out", "s.md"])).toEqual({ exitCode: 0, stdout: "", stderr: "markdown  s.md\n" });
    expect(readFileSync(path.join(rootDir, "s.md"), "utf8")).toBe(
      readFileSync(path.join(rootDir, ".nukadoko", "runs", runId, "summary.md"), "utf8"),
    );
  });

  it("writes Allure results to .nukadoko/export/allure-results by default, one result per scenario", async () => {
    await run();
    expect(await cli(["report", "--format", "allure"])).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "allure    .nukadoko/export/allure-results/  1\n",
    });
    expect(existsSync(path.join(resultsDir(), "categories.json"))).toBe(true);
    expect(readFileSync(path.join(resultsDir(), "environment.properties"), "utf8")).toBe("environment=default");
    expect(resultFiles(resultsDir())).toHaveLength(1);
  });

  it("replaces its own earlier render of the same run instead of adding a second copy", async () => {
    await run();
    expect((await cli(["report", "--format", "allure"])).exitCode).toBe(0);
    const first = readdirSync(resultsDir()).sort();
    expect((await cli(["report", "--format", "allure"])).exitCode).toBe(0);
    expect(readdirSync(resultsDir())).toHaveLength(first.length);
    expect(resultFiles(resultsDir())).toHaveLength(1);
  });

  it("gives two runs of the same feature one historyId", async () => {
    await run();
    expect((await cli(["report", "--format", "allure"])).exitCode).toBe(0);
    const [first] = historyIds(resultsDir());
    expect(typeof first).toBe("string");
    await run();
    expect((await cli(["report", "--format", "allure"])).exitCode).toBe(0);
    expect(historyIds(resultsDir())).toEqual([first, first]);
  });

  it("renders a scenario whose step returns nothing with no result attachment", async () => {
    await run("features/void-result.feature");
    expect((await cli(["report", "--format", "allure"])).exitCode).toBe(0);
    const results = resultFiles(resultsDir()).map((name) => readResult(resultsDir(), name)) as {
      name?: string;
      status?: string;
      steps?: { attachments?: { name: string }[] }[];
    }[];
    expect(results.map((result) => [result.name, result.status])).toEqual([["a step that returns nothing", "passed"]]);
    expect(results[0]!.steps!.map((step) => step.attachments!.map((attachment) => attachment.name))).toEqual([["record.json"]]);
  });

  it("writes a cucumber-messages stream on stdout, with the version and verdict of the run", async () => {
    await run();
    const result = await cli(["report", "--format", "messages"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const envelopes = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(envelopes[0]!.meta.implementation).toEqual({ name: "nukadoko", version: readOwnVersion() });
    expect(envelopes.filter((envelope) => "testCase" in envelope)).toHaveLength(1);
    expect(envelopes.at(-1)!.testRunFinished.success).toBe(true);
  });

  it("gives a run with a failing scenario testRunFinished.success false", async () => {
    expect((await cli(["run", "--no-check", "features/failing.feature"])).exitCode).toBe(1);
    const result = await cli(["report", "--format", "messages"]);
    expect(result.exitCode).toBe(0);
    const last = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { testRunFinished: { success: boolean } };
    expect(last.testRunFinished.success).toBe(false);
  });

  it("refuses --json without --out for a format that prints to stdout", async () => {
    await run();
    const result = await cli(["report", "--format", "messages", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: 2,
      nukadoko: readOwnVersion(),
      command: "report",
      verdict: "refused",
      findings: [
        {
          severity: "refused",
          code: "invalid-arguments",
          message: "nuka report --json needs --out for --format messages, since the messages output itself would go to stdout",
          fix: "Add --out <path>.",
        },
      ],
    });
  });

  it("names the run and what it wrote under --json", async () => {
    const runId = await run();
    const result = await cli(["report", "--format", "allure", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: 2,
      nukadoko: readOwnVersion(),
      command: "report",
      verdict: "passed",
      findings: [],
      run_id: runId,
      format: "allure",
      written: [path.join(".nukadoko", "export", "allure-results")],
    });
  });

  it("refuses a directory that holds no run.json", async () => {
    expect(await cli(["report", "nowhere", "--format", "allure", "--out", "x"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        `refused\trun-not-found\t-\t${path.join(rootDir, "nowhere")} holds no run.json that nuka run wrote\n` +
        "  fix: Name a run directory that holds a run.json, or run nuka run first.\n  do: nuka report --help\n",
    });
  });

  describe("a run directory copied out of its project", () => {
    let elsewhere: string;

    beforeEach(() => {
      elsewhere = mkdtempSync(path.join(os.tmpdir(), "nukadoko-report-copy-"));
    });

    afterEach(() => {
      rmSync(elsewhere, { recursive: true, force: true });
    });

    it("renders with the same Allure identity as in the project, with no config", async () => {
      const runId = await run();
      expect((await cli(["report", "--format", "allure"])).exitCode).toBe(0);
      const inProject = resultFiles(resultsDir()).map((name) => readResult(resultsDir(), name));
      cpSync(path.join(rootDir, ".nukadoko", "runs", runId), path.join(elsewhere, "copied"), { recursive: true });
      await removeTempDir(rootDir);
      rootDir = await copyFixtureToTempDir("run-project");

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      expect(
        await runCli(["report", "copied", "--format", "allure", "--out", "out"], { rootDir: elsewhere, stdout, stderr }),
      ).toBe(0);
      const copied = resultFiles(path.join(elsewhere, "out")).map((name) => readResult(path.join(elsewhere, "out"), name));
      const identity = (result: Record<string, unknown>) => [result.fullName, result.historyId, result.testCaseId, result.status];
      expect(copied.map(identity)).toEqual(inProject.map(identity));
    });

    // Each edit of a copied run, and the refusal it gets: the field or the
    // file that is wrong is named, instead of a TypeError later on.
    const EDITS: readonly [string, string, (copy: string) => void, string, string][] = [
      [
        "a run.json without environments",
        "run-invalid",
        (copy) => {
          const document = JSON.parse(readFileSync(path.join(copy, "run.json"), "utf8")) as Record<string, unknown>;
          delete document.environments;
          writeFileSync(path.join(copy, "run.json"), JSON.stringify(document));
        },
        "run.json does not have the fields nuka report reads: environments: Invalid input: expected array, received undefined",
        "Render a run directory that nuka run of this release wrote, unedited; the message names what is wrong.",
      ],
      [
        "a run.json of another schema version",
        "run-invalid",
        (copy) => {
          const document = JSON.parse(readFileSync(path.join(copy, "run.json"), "utf8")) as Record<string, unknown>;
          writeFileSync(path.join(copy, "run.json"), JSON.stringify({ ...document, schema_version: 1 }));
        },
        "run.json has schema_version 1, and this release reads 2",
        "Render a run directory that nuka run of this release wrote, unedited; the message names what is wrong.",
      ],
      [
        "a sources.json of another schema version",
        "run-sources-invalid",
        (copy) => writeFileSync(path.join(copy, "sources.json"), JSON.stringify({ schema_version: 7, project: null, features: [] })),
        "holds a sources.json with schema_version 7, and this release reads 1, so the scenarios of run <run> cannot be parsed",
        "Render a run directory that nuka run of this release wrote, unedited; the message names what is wrong.",
      ],
      [
        "a run.json that is a symlink out of the run directory",
        "run-invalid",
        (copy) => {
          renameSync(path.join(copy, "run.json"), path.join(elsewhere, "run.json"));
          symlinkSync(path.join(elsewhere, "run.json"), path.join(copy, "run.json"));
        },
        "run.json resolves outside the run directory, so it is not read",
        "Render a run directory that nuka run of this release wrote, unedited; the message names what is wrong.",
      ],
      [
        "a sources.json that is a symlink out of the run directory",
        "run-sources-invalid",
        (copy) => {
          renameSync(path.join(copy, "sources.json"), path.join(elsewhere, "sources.json"));
          symlinkSync(path.join(elsewhere, "sources.json"), path.join(copy, "sources.json"));
        },
        "holds a sources.json that resolves outside the run directory, so the scenarios of run <run> cannot be parsed",
        "Render a run directory that nuka run of this release wrote, unedited; the message names what is wrong.",
      ],
      [
        "a run.json whose run_id is not one path segment",
        "run-invalid",
        (copy) => {
          const document = JSON.parse(readFileSync(path.join(copy, "run.json"), "utf8")) as Record<string, unknown>;
          writeFileSync(path.join(copy, "run.json"), JSON.stringify({ ...document, run_id: "../../x" }));
        },
        "run.json does not have the fields nuka report reads: run_id: expected a run id nuka run generates, run-YYYYMMDD-HHMMSS-xxxx",
        "Render a run directory that nuka run of this release wrote, unedited; the message names what is wrong.",
      ],
    ];

    for (const [name, code, edit, ending, fix] of EDITS) {
      it(`refuses ${name} with ${code}`, async () => {
        const runId = await run();
        const copy = path.join(elsewhere, "copied");
        cpSync(path.join(rootDir, ".nukadoko", "runs", runId), copy, { recursive: true });
        edit(copy);
        const stdout = createCaptureSink();
        const stderr = createCaptureSink();
        expect(await runCli(["report", "copied", "--format", "allure", "--out", "out"], { rootDir: elsewhere, stdout, stderr })).toBe(2);
        const [line, fixLine] = withoutNoConfigLine(stderr.text()).split("\n");
        expect(line!.startsWith(`refused\t${code}\t-\t${copy}`)).toBe(true);
        expect(line!.endsWith(ending.replace("<run>", runId))).toBe(true);
        expect(fixLine).toBe(`  fix: ${fix}`);
      });
    }

    it("refuses with run-sources-missing when sources.json is gone", async () => {
      const runId = await run();
      cpSync(path.join(rootDir, ".nukadoko", "runs", runId), path.join(elsewhere, "copied"), { recursive: true });
      rmSync(path.join(elsewhere, "copied", "sources.json"));
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      expect(await runCli(["report", "copied", "--format", "messages", "--out", "m.ndjson"], { rootDir: elsewhere, stdout, stderr })).toBe(2);
      expect(withoutNoConfigLine(stderr.text())).toBe(
        `refused\trun-sources-missing\t-\t${path.join(elsewhere, "copied")} holds no sources.json, so the scenarios of run ${runId} cannot be parsed\n` +
          "  fix: Run the scenarios again with this release, and render that run.\n  do: nuka report --help\n",
      );
    });
  });
});

describe("nuka report after nuka run --concurrency", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), 'import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({});\n');
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("renders every scenario the workers ran, and the run itself writes no export file", async () => {
    await runCli(["run", "--no-check", "features/basic/", "--concurrency", "2"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(existsSync(path.join(rootDir, ".nukadoko", "export"))).toBe(false);
    expect(await runCli(["report", "--format", "allure"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() })).toBe(0);
    const dir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    const names = resultFiles(dir).map((name) => readResult(dir, name).fullName as string).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("features/basic/a.feature#");
    expect(names[1]).toContain("features/basic/b.feature#");
  }, 60_000);
});
