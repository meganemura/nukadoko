import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { refuseExportTarget } from "../src/cli/clean.js";
import { runCli } from "../src/cli/run-cli.js";
import { readOwnVersion } from "../src/version.js";
import { messagesRunOutputPath } from "../src/record/messages-output.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

/** A pid guaranteed to already be dead: spawnSync blocks until the child
 * has exited, so by the time it returns, its pid is free to be reused as a
 * "the process that held this lock is gone" fixture — the same trick
 * session.test.ts uses for the same reason (a literal constant like
 * 999999 is a real, possibly another user's, process on a machine with a
 * large pid_max, e.g. Linux's default). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) {
    throw new Error("spawnSync did not report a pid");
  }
  return child.pid;
}

// Responsibility: `nuka clean` — what it deletes (records/steps,
// records/scenarios, cache/sessions/<env>/*, export/allure-results,
// export/messages.ndjson), what it refuses to touch (`export/allure-
// history.jsonl`), and
// `--dry-run`/`--json`/category selection. Seeds `.nukadoko/` by hand
// rather than by running real steps: this is a state-directory-shape test,
// not a re-test of what `nuka do`/`nuka run` already write (session.test.ts,
// run-session.test.ts).

function stateDir(rootDir: string): string {
  return path.join(rootDir, ".nukadoko");
}

/** Overwrites the fixture config. The shim import is what lets this temp
 * copy load `defineConfig` without a published package. */
async function writeExportConfig(
  rootDir: string,
  options: { allureResultsDir?: string; messagesOutput?: string; stateDir?: string },
): Promise<void> {
  const fields: string[] = [];
  if (options.stateDir !== undefined) fields.push(`stateDir: ${JSON.stringify(options.stateDir)}`);
  if (options.allureResultsDir !== undefined) {
    fields.push(`allure: { resultsDir: ${JSON.stringify(options.allureResultsDir)} }`);
  }
  if (options.messagesOutput !== undefined) {
    fields.push(`messages: { output: ${JSON.stringify(options.messagesOutput)} }`);
  }
  await writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    `import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({ ${fields.join(", ")} });\n`,
  );
}

async function seedRecords(rootDir: string): Promise<void> {
  await mkdir(path.join(stateDir(rootDir), "records", "steps", "step-aaa"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "records", "steps", "step-aaa", "record.json"), "{}");
  await mkdir(path.join(stateDir(rootDir), "records", "scenarios", "scenario-bbb"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "records", "scenarios", "scenario-bbb", "record.json"), "{}");
  await mkdir(path.join(stateDir(rootDir), "records", "runs", "run-ccc"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "records", "runs", "run-ccc", "exports"), "");
}

async function seedCache(rootDir: string, environment = "default"): Promise<void> {
  const dir = path.join(stateDir(rootDir), "cache", "sessions", environment);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "alpha.json"), JSON.stringify({ cookies: [], origins: [] }));
}

async function seedExport(rootDir: string): Promise<void> {
  const resultsDir = path.join(stateDir(rootDir), "export", "allure-results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, "some-result.json"), "{}");
  await writeFile(path.join(stateDir(rootDir), "export", "allure-history.jsonl"), '{"kept":true}\n');
  await writeFile(path.join(stateDir(rootDir), "export", "messages.ndjson"), "line1\n");
}

/** One leftover run-id-suffixed sibling of `export/messages.ndjson`
 * (src/report/messages/emitter.ts's own header: every `nuka run`
 * invocation leaves one of these behind, distinct from the stable path
 * itself) — seeded by hand here, the same as every other file this test
 * file seeds, rather than by actually running `nuka run`. */
async function seedExportRunFile(rootDir: string, runId: string): Promise<void> {
  const output = path.join(stateDir(rootDir), "export", "messages.ndjson");
  await writeFile(messagesRunOutputPath(output, runId), "line1\n");
}

describe("nuka clean", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("session-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("does nothing and exits 0 against a project with no state directory yet", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("ok: nothing to clean");
  });

  it("creates no results directory where none was", async () => {
    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(stateDir(rootDir), "export", "allure-results"))).toBe(false);
  });

  it("finds nothing to clean right after a clean", async () => {
    await seedRecords(rootDir);
    await seedExport(rootDir);
    await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });

    const stdout = createCaptureSink();
    const exitCode = await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("ok: nothing to clean\n");
    expect(await readdir(path.join(stateDir(rootDir), "export", "allure-results"))).toEqual([]);
  });

  it("--dry-run lists every category's targets and deletes nothing", async () => {
    await seedRecords(rootDir);
    await seedCache(rootDir);
    await seedExport(rootDir);
    await seedExportRunFile(rootDir, "run-seed-0001");

    const stdout = createCaptureSink();
    const exitCode = await runCli(["clean", "--dry-run"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(0);

    const text = stdout.text();
    expect(text).toContain(path.join(".nukadoko", "records", "steps", "step-aaa"));
    expect(text).toContain(path.join(".nukadoko", "records", "scenarios", "scenario-bbb"));
    expect(text).toContain(path.join(".nukadoko", "records", "runs", "run-ccc"));
    expect(text).toContain(path.join(".nukadoko", "cache", "sessions", "default", "alpha.json"));
    expect(text).toContain(path.join(".nukadoko", "export", "allure-results"));
    expect(text).toContain(path.join(".nukadoko", "export", "messages.ndjson"));
    expect(text).toContain(path.join(".nukadoko", "export", "messages.run-seed-0001.ndjson"));

    // Nothing actually removed.
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "cache", "sessions", "default", "alpha.json"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "allure-results", "some-result.json"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "messages.run-seed-0001.ndjson"))).toBe(true);
  });

  it("--json reports the same plan as a structured object", async () => {
    await seedRecords(rootDir);

    const stdout = createCaptureSink();
    const exitCode = await runCli(["clean", "--dry-run", "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text());
    expect(report.records).toEqual(
      expect.arrayContaining([
        path.join(".nukadoko", "records", "steps", "step-aaa"),
        path.join(".nukadoko", "records", "scenarios", "scenario-bbb"),
      ]),
    );
    expect(report.dry_run).toBe(true);
  });

  it("deletes accumulated records/steps, records/scenarios, and records/runs", async () => {
    await seedRecords(rootDir);

    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "records", "scenarios", "scenario-bbb"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "records", "runs", "run-ccc"))).toBe(false);
  });

  it("deletes a non-live session's cache files", async () => {
    await seedCache(rootDir);

    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(stateDir(rootDir), "cache", "sessions", "default", "alpha.json"))).toBe(false);
  });

  it("deletes export/allure-results contents but recreates the directory empty, and never touches allure-history.jsonl", async () => {
    await seedExport(rootDir);
    await seedExportRunFile(rootDir, "run-seed-0001");

    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);

    const resultsDir = path.join(stateDir(rootDir), "export", "allure-results");
    expect(existsSync(resultsDir)).toBe(true);
    expect(await readdir(resultsDir)).toEqual([]);
    expect(existsSync(path.join(stateDir(rootDir), "export", "messages.ndjson"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "export", "messages.run-seed-0001.ndjson"))).toBe(false);

    const historyPath = path.join(stateDir(rootDir), "export", "allure-history.jsonl");
    expect(existsSync(historyPath)).toBe(true);
  });

  it("deletes every run-id-suffixed messages file, however many accumulated, and leaves an unrelated file with a similar name alone", async () => {
    await seedExport(rootDir);
    await seedExportRunFile(rootDir, "run-seed-0001");
    await seedExportRunFile(rootDir, "run-seed-0002");
    // A file that merely sits beside messages.ndjson but doesn't match this
    // emitter's own naming rule (src/report/messages/emitter.ts's own
    // `isMessagesRunOutputFileName`) — a clean this broad must still leave
    // it alone.
    await writeFile(path.join(stateDir(rootDir), "export", "other.ndjson"), "unrelated\n");

    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);

    expect(existsSync(path.join(stateDir(rootDir), "export", "messages.run-seed-0001.ndjson"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "export", "messages.run-seed-0002.ndjson"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "export", "other.ndjson"))).toBe(true);
  });

  it.each(["--records", "--cache", "--export"])("refuses %s by name, says clean removes every category, and deletes nothing", async (flag) => {
    await seedRecords(rootDir);
    await seedCache(rootDir);
    await seedExport(rootDir);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean", flag], { rootDir, stdout, stderr });
    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      `refused\tremoved-command\t-\tnuka clean ${flag} is removed: nuka clean always removes records, cache, and export together; ` +
        "nuka clean --dry-run lists what it would remove.\n  fix: Use what the message names in its place.\n  do: nuka clean --help\n",
    );
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "cache", "sessions", "default", "alpha.json"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "allure-results", "some-result.json"))).toBe(true);
  });

  it("refuses a removed flag as one JSON object under --json", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean", "--cache", "--json"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toEqual({
      schema_version: 2,
      nukadoko: readOwnVersion(),
      command: "clean",
      verdict: "refused",
      findings: [
        {
          severity: "refused",
          code: "removed-command",
          message:
            "nuka clean --cache is removed: nuka clean always removes records, cache, and export together; " +
            "nuka clean --dry-run lists what it would remove.",
          fix: "Use what the message names in its place.",
          do: "nuka clean --help",
        },
      ],
    });
  });

  it("removes a stale lock whose own pid is dead", async () => {
    await seedRecords(rootDir);
    const dir = path.join(stateDir(rootDir), "cache", "sessions", "default");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "stale.lock"),
      JSON.stringify({ pid: deadPid(), started_at: new Date().toISOString() }),
    );

    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(false);
    expect(existsSync(path.join(dir, "stale.lock"))).toBe(false);
  });

  it("still removes a results directory that stays inside the project and is not a parent of the state directory", async () => {
    await writeExportConfig(rootDir, { allureResultsDir: "reports/allure" });
    const resultsDir = path.join(rootDir, "reports", "allure");
    await mkdir(resultsDir, { recursive: true });
    await writeFile(path.join(resultsDir, "some-result.json"), "{}");
    await writeFile(path.join(rootDir, "reports", "keep.txt"), "keep");

    const exitCode = await runCli(["clean"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(existsSync(resultsDir)).toBe(true);
    expect(await readdir(resultsDir)).toEqual([]);
    expect(existsSync(path.join(rootDir, "reports", "keep.txt"))).toBe(true);
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
  });

  it("refuses an allure resultsDir that is the project root and deletes nothing", async () => {
    await writeExportConfig(rootDir, { allureResultsDir: "." });
    await seedRecords(rootDir);
    await writeFile(path.join(rootDir, "keep-me.txt"), "keep");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("refusing");
    expect(stderr.text()).toContain("project root");
    expect(existsSync(path.join(rootDir, "keep-me.txt"))).toBe(true);
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(true);
  });

  it("refuses a dry-run whose resultsDir is the project root, and deletes nothing", async () => {
    await writeExportConfig(rootDir, { allureResultsDir: "." });
    await writeFile(path.join(rootDir, "keep-me.txt"), "keep");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean", "--dry-run"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("refusing");
    expect(stderr.text()).toContain("project root");
    expect(existsSync(path.join(rootDir, "keep-me.txt"))).toBe(true);
  });

  it("refuses a messages output that is the project root and deletes nothing", async () => {
    await writeExportConfig(rootDir, { messagesOutput: "." });
    await seedRecords(rootDir);
    await writeFile(path.join(rootDir, "keep-me.txt"), "keep");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("refusing");
    expect(stderr.text()).toContain("project root");
    expect(existsSync(path.join(rootDir, "keep-me.txt"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(true);
  });

  it("refuses a resultsDir that resolves outside the project and leaves that path in place", async () => {
    const outside = path.join(path.dirname(rootDir), `outside-results-${path.basename(rootDir)}`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "keep");
    try {
      await writeExportConfig(rootDir, { allureResultsDir: path.relative(rootDir, outside) });
      await writeFile(path.join(rootDir, "keep-me.txt"), "keep");

      const stderr = createCaptureSink();
      const exitCode = await runCli(["clean"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      });
      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain("refusing");
      expect(stderr.text()).toContain("outside the project");
      expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
      expect(existsSync(path.join(rootDir, "keep-me.txt"))).toBe(true);
    } finally {
      await removeTempDir(outside);
    }
  });

  it("refuses a messages output that resolves outside the project and leaves that file in place", async () => {
    const outside = path.join(path.dirname(rootDir), `outside-messages-${path.basename(rootDir)}`);
    await mkdir(outside, { recursive: true });
    const output = path.join(outside, "messages.ndjson");
    await writeFile(output, "line1\n");
    try {
      await writeExportConfig(rootDir, { messagesOutput: path.relative(rootDir, output) });
      await writeFile(path.join(rootDir, "keep-me.txt"), "keep");

      const stderr = createCaptureSink();
      const exitCode = await runCli(["clean"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      });
      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain("refusing");
      expect(stderr.text()).toContain("outside the project");
      expect(existsSync(output)).toBe(true);
      expect(existsSync(path.join(rootDir, "keep-me.txt"))).toBe(true);
    } finally {
      await removeTempDir(outside);
    }
  });

  it("refuses a resultsDir that is a parent of the state directory and deletes nothing under it", async () => {
    await writeExportConfig(rootDir, { stateDir: "bed/state", allureResultsDir: "bed" });
    await mkdir(path.join(rootDir, "bed", "state"), { recursive: true });
    await writeFile(path.join(rootDir, "bed", "keep.txt"), "keep");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("refusing");
    expect(stderr.text()).toContain("state directory");
    expect(existsSync(path.join(rootDir, "bed", "keep.txt"))).toBe(true);
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
  });

  it("refuses an absolute resultsDir outside the project and leaves that path in place", async () => {
    const outside = path.join(path.dirname(rootDir), `abs-outside-${path.basename(rootDir)}`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "keep");
    try {
      await writeExportConfig(rootDir, { allureResultsDir: outside });
      await writeFile(path.join(rootDir, "keep-me.txt"), "keep");

      const stderr = createCaptureSink();
      const exitCode = await runCli(["clean"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      });
      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain("outside the project");
      expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
      expect(existsSync(path.join(rootDir, "keep-me.txt"))).toBe(true);
    } finally {
      await removeTempDir(outside);
    }
  });

  it("an unknown flag fails setup: exit 2, nothing deleted (yargs runs the matched handler after .fail() unless run-cli.ts guards it)", async () => {
    await seedRecords(rootDir);

    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean", "--unknown-flag"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("unknown-flag");
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(true);
  });
});

const pathSegment = gs.text({ alphabet: "abc", minSize: 1, maxSize: 6 });
const pathSegments = gs.arrays(pathSegment, { minSize: 1, maxSize: 4 });

function refused(rootDir: string, stateDir: string, configuredPath: string): boolean {
  return refuseExportTarget(rootDir, stateDir, configuredPath, "allure.resultsDir") !== null;
}

describe("refuseExportTarget", () => {
  it("allows every path that stays under reports/ when the state directory is .nukadoko", () =>
    hegel.test((tc) => {
      const relative = path.join("reports", ...tc.draw(pathSegments));
      expect(refuseExportTarget("/proj/app", ".nukadoko", relative, "allure.resultsDir")).toBe(null);
    }));

  it("allows a path strictly inside the state directory", () =>
    hegel.test((tc) => {
      const state = path.join("bed", ...tc.draw(gs.arrays(pathSegment, { minSize: 0, maxSize: 2 })), "state");
      const target = path.join(state, "export", ...tc.draw(gs.arrays(pathSegment, { minSize: 0, maxSize: 3 })));
      expect(refuseExportTarget("/proj/app", state, target, "allure.resultsDir")).toBe(null);
    }));

  it("refuses every spelling that resolves to the project root", () =>
    hegel.test((tc) => {
      const parts = tc.draw(pathSegments);
      const spelling = path.join(...parts, ...parts.map(() => ".."));
      const root = "/proj/app";
      expect(path.resolve(root, spelling)).toBe(root);
      expect(refuseExportTarget(root, ".nukadoko", spelling, "messages.output")).toContain("project root");
    }));

  it("refuses a path that climbs out of the project", () =>
    hegel.test((tc) => {
      const ups = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
      const climbing = path.join(...Array.from({ length: ups }, () => ".."), ...tc.draw(pathSegments));
      const refusal = refuseExportTarget("/proj/app", ".nukadoko", climbing, "allure.resultsDir");
      expect(refusal).toContain("outside the project");
    }));

  it("refuses a path that is a parent of the state directory", () =>
    hegel.test((tc) => {
      const parts = tc.draw(pathSegments);
      const state = path.join(...parts, "state");
      const parentDepth = tc.draw(gs.integers({ minValue: 1, maxValue: parts.length }));
      const parent = path.join(...parts.slice(0, parentDepth));
      expect(refuseExportTarget("/proj/app", state, parent, "allure.resultsDir")).toContain("state directory");
    }));

  it("agrees for a relative spelling and the absolute path it resolves to", () =>
    hegel.test((tc) => {
      const root = path.join("/proj", tc.draw(pathSegment));
      const state = ".nukadoko";
      const inside = path.join("reports", ...tc.draw(pathSegments));
      const outside = path.join("..", "out", ...tc.draw(pathSegments));
      expect(refused(root, state, inside)).toBe(refused(root, state, path.resolve(root, inside)));
      expect(refused(root, state, outside)).toBe(refused(root, state, path.resolve(root, outside)));
      expect(refused(root, state, inside)).toBe(false);
      expect(refused(root, state, outside)).toBe(true);
    }));
});
