import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { messagesRunOutputPath } from "../src/report/messages/emitter.js";
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
// history.jsonl`, and everything, when any session anywhere is live), and
// `--dry-run`/`--json`/category selection. Seeds `.nukadoko/` by hand
// rather than by running real steps: this is a state-directory-shape test,
// not a re-test of what `nuka do`/`nuka run` already write (session.test.ts,
// run-session.test.ts).

function stateDir(rootDir: string): string {
  return path.join(rootDir, ".nukadoko");
}

async function seedRecords(rootDir: string): Promise<void> {
  await mkdir(path.join(stateDir(rootDir), "records", "steps", "step-aaa"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "records", "steps", "step-aaa", "record.json"), "{}");
  await mkdir(path.join(stateDir(rootDir), "records", "scenarios", "scenario-bbb"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "records", "scenarios", "scenario-bbb", "record.json"), "{}");
}

async function seedCache(rootDir: string, environment = "default"): Promise<void> {
  const dir = path.join(stateDir(rootDir), "cache", "sessions", environment);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "alpha.json"), JSON.stringify({ cookies: [], origins: [] }));
}

async function seedLiveLock(rootDir: string, name: string, environment = "default"): Promise<void> {
  const dir = path.join(stateDir(rootDir), "cache", "sessions", environment);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${name}.lock`),
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
  );
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

  it("deletes accumulated records/steps and records/scenarios", async () => {
    await seedRecords(rootDir);

    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "records", "scenarios", "scenario-bbb"))).toBe(false);
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

  it("--records cleans only records, leaving cache and export untouched", async () => {
    await seedRecords(rootDir);
    await seedCache(rootDir);
    await seedExport(rootDir);

    const exitCode = await runCli(["clean", "--records"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "cache", "sessions", "default", "alpha.json"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "allure-results", "some-result.json"))).toBe(true);
  });

  it("refuses the whole clean, records included, when any session anywhere is live", async () => {
    await seedRecords(rootDir);
    await seedLiveLock(rootDir, "live1");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("live1");
    expect(stderr.text()).toContain("nuka session stop live1");
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(true);
  });

  it("still refuses a --records-only clean when the live session is in a non-default environment", async () => {
    await seedRecords(rootDir);
    await seedLiveLock(rootDir, "live2", "staging");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean", "--records"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("live2");
    expect(stderr.text()).toContain("staging");
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(true);
  });

  it("proceeds once the live lock's own pid is dead (stale, not live)", async () => {
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

  it("an unknown flag fails setup: exit 1, nothing deleted (yargs runs the matched handler after .fail() unless run-cli.ts guards it)", async () => {
    await seedRecords(rootDir);

    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean", "--unknown-flag"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("unknown-flag");
    expect(existsSync(path.join(stateDir(rootDir), "records", "steps", "step-aaa"))).toBe(true);
  });
});
