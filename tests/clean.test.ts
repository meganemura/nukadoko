import { existsSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readOwnVersion } from "../src/version.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka clean`: what it deletes (runs/<run_id>, do/<id>,
// and every entry of export/), what it never touches
// (`export/allure-history.jsonl`, and a report written outside the state
// directory), and `--dry-run`/`--json`. Seeds `.nukadoko/` by hand rather
// than by running real steps: this is a state-directory-shape test, not a
// re-test of what `nuka do`, `nuka run`, and `nuka report` write.

function stateDir(rootDir: string): string {
  return path.join(rootDir, ".nukadoko");
}

async function seedRecords(rootDir: string): Promise<void> {
  await mkdir(path.join(stateDir(rootDir), "do", "step-aaa"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "do", "step-aaa", "record.json"), "{}");
  await mkdir(path.join(stateDir(rootDir), "runs", "run-ccc", "scenarios", "scenario-bbb"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "runs", "run-ccc", "scenarios", "scenario-bbb", "record.json"), "{}");
  await mkdir(path.join(stateDir(rootDir), "runs", "run-ccc"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "runs", "run-ccc", "exports"), "");
}

async function seedExport(rootDir: string): Promise<void> {
  const resultsDir = path.join(stateDir(rootDir), "export", "allure-results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, "some-result.json"), "{}");
  await writeFile(path.join(stateDir(rootDir), "export", "allure-history.jsonl"), '{"kept":true}\n');
  await writeFile(path.join(stateDir(rootDir), "export", "messages.ndjson"), "line1\n");
  // messages.ndjson is a file nuka report wrote of run-ccc, so its manifest
  // names it; the two files beside it are a person's own.
  await mkdir(path.join(stateDir(rootDir), "runs", "run-ccc"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "runs", "run-ccc", "exports"), `${path.join(".nukadoko", "export", "messages.ndjson")}\n`);
  await mkdir(path.join(stateDir(rootDir), "export", "allure-report"), { recursive: true });
  await writeFile(path.join(stateDir(rootDir), "export", "allure-report", "index.html"), "<html></html>");
  await writeFile(path.join(stateDir(rootDir), "export", "my-history.jsonl"), "{}\n");
}

describe("nuka clean", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
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

  it("lists and removes the cache/ and records/ directories an earlier release wrote", async () => {
    await mkdir(path.join(stateDir(rootDir), "cache", "sessions"), { recursive: true });
    await writeFile(path.join(stateDir(rootDir), "cache", "sessions", "alice.json"), '{"cookies":[]}');
    await mkdir(path.join(stateDir(rootDir), "records", "scenarios", "scn-a"), { recursive: true });

    const dryRun = createCaptureSink();
    expect(await runCli(["clean", "--dry-run", "--json"], { rootDir, stdout: dryRun, stderr: createCaptureSink() })).toBe(0);
    expect((JSON.parse(dryRun.text()) as { legacy: string[] }).legacy).toEqual([".nukadoko/cache", ".nukadoko/records"]);
    expect(existsSync(path.join(stateDir(rootDir), "cache", "sessions", "alice.json"))).toBe(true);

    const stdout = createCaptureSink();
    expect(await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    expect(stdout.text()).toBe(".nukadoko/cache\n.nukadoko/records\n");
    expect([existsSync(path.join(stateDir(rootDir), "cache")), existsSync(path.join(stateDir(rootDir), "records"))]).toEqual([false, false]);
  });

  it("says in its help that the cache it removes is the one earlier releases left", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logged.push(parts.join(" "));
    });
    try {
      await runCli(["clean", "--help"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n").replace(/\s+/g, " ")).toContain(
      "delete accumulated runs, do records, what nuka report wrote under export/ (the files a run's manifest names and the contents of allure-results; every other file stays), " +
        "and the cache/ and records/ directories earlier releases left, in the state directory",
    );
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
    await seedExport(rootDir);

    const stdout = createCaptureSink();
    const exitCode = await runCli(["clean", "--dry-run"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(0);

    const text = stdout.text();
    // One line per run directory, then one per `nuka do` record: a run's
    // scenario evidence leaves with its run, and is not listed apart.
    expect(text).toContain(`${path.join(".nukadoko", "runs", "run-ccc")}\n${path.join(".nukadoko", "do", "step-aaa")}\n`);
    expect(text).not.toContain("scenario-bbb");
    expect(text).toContain(path.join(".nukadoko", "export", "allure-results"));
    expect(text).toContain(path.join(".nukadoko", "export", "messages.ndjson"));

    // Nothing actually removed.
    expect(existsSync(path.join(stateDir(rootDir), "do", "step-aaa"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "allure-results", "some-result.json"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "messages.ndjson"))).toBe(true);
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
    expect(report.records).toEqual([path.join(".nukadoko", "runs", "run-ccc"), path.join(".nukadoko", "do", "step-aaa")]);
    expect(report.dry_run).toBe(true);
  });

  it("deletes every run directory, with the scenario evidence inside it, and every nuka do record", async () => {
    await seedRecords(rootDir);

    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(stateDir(rootDir), "do", "step-aaa"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "runs", "run-ccc", "scenarios", "scenario-bbb"))).toBe(false);
    expect(existsSync(path.join(stateDir(rootDir), "runs", "run-ccc"))).toBe(false);
  });

  it("deletes what a run's exports manifest names and the contents of allure-results, recreates allure-results empty, and keeps every other file in export/", async () => {
    await seedExport(rootDir);

    const exitCode = await runCli(["clean"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    expect(exitCode).toBe(0);

    const resultsDir = path.join(stateDir(rootDir), "export", "allure-results");
    expect(existsSync(resultsDir)).toBe(true);
    expect(await readdir(resultsDir)).toEqual([]);
    expect(existsSync(path.join(stateDir(rootDir), "export", "messages.ndjson"))).toBe(false);

    const historyPath = path.join(stateDir(rootDir), "export", "allure-history.jsonl");
    expect(existsSync(historyPath)).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "allure-report", "index.html"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "my-history.jsonl"))).toBe(true);
  });

  it("does not follow a manifest line that leaves export/", async () => {
    await mkdir(path.join(stateDir(rootDir), "runs", "run-ddd"), { recursive: true });
    await writeFile(path.join(stateDir(rootDir), "runs", "run-ddd", "exports"), "nukadoko.config.ts\n");
    const stdout = createCaptureSink();
    expect(await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    expect(stdout.text()).toBe(`${path.join(".nukadoko", "runs", "run-ddd")}\n`);
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
  });

  it("does not follow a manifest line that leaves export/ through a symlinked directory, nor a symlinked manifest", async () => {
    await mkdir(path.join(stateDir(rootDir), "export"), { recursive: true });
    await symlink(rootDir, path.join(stateDir(rootDir), "export", "evil"));
    await writeFile(path.join(rootDir, "keep.txt"), "keep");
    await writeFile(path.join(rootDir, "forged-manifest"), `${path.join(".nukadoko", "export", "evil", "keep.txt")}\nkeep.txt\n`);
    await mkdir(path.join(stateDir(rootDir), "runs", "run-fff"), { recursive: true });
    await writeFile(path.join(stateDir(rootDir), "runs", "run-fff", "exports"), `${path.join(".nukadoko", "export", "evil", "nukadoko.config.ts")}\n`);
    await mkdir(path.join(stateDir(rootDir), "runs", "run-ggg"), { recursive: true });
    await symlink(path.join(rootDir, "forged-manifest"), path.join(stateDir(rootDir), "runs", "run-ggg", "exports"));
    const stdout = createCaptureSink();
    expect(await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    expect(stdout.text()).toBe(`${path.join(".nukadoko", "runs", "run-fff")}\n${path.join(".nukadoko", "runs", "run-ggg")}\n`);
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
    expect(existsSync(path.join(rootDir, "keep.txt"))).toBe(true);
    expect(existsSync(path.join(rootDir, "forged-manifest"))).toBe(true);
  });

  it("does not follow a manifest line that names a directory, a symlink, or allure-history.jsonl, and removes the regular file beside them", async () => {
    const exportDir = path.join(stateDir(rootDir), "export");
    await mkdir(path.join(exportDir, "allure-report"), { recursive: true });
    await writeFile(path.join(exportDir, "allure-report", "index.html"), "<html></html>");
    await writeFile(path.join(exportDir, "allure-history.jsonl"), '{"kept":true}\n');
    await writeFile(path.join(exportDir, "own.md"), "own");
    await writeFile(path.join(exportDir, "target.md"), "target");
    await symlink(path.join(exportDir, "target.md"), path.join(exportDir, "link.md"));
    await mkdir(path.join(stateDir(rootDir), "runs", "run-hhh"), { recursive: true });
    const lines = ["allure-report", "allure-history.jsonl", "link.md", "own.md"].map((name) => path.join(".nukadoko", "export", name));
    await writeFile(path.join(stateDir(rootDir), "runs", "run-hhh", "exports"), `${lines.join("\n")}\n`);
    const stdout = createCaptureSink();
    expect(await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    expect(stdout.text()).toBe(`${path.join(".nukadoko", "runs", "run-hhh")}\n${path.join(".nukadoko", "export", "own.md")}\n`);
    expect(existsSync(path.join(exportDir, "allure-report", "index.html"))).toBe(true);
    expect(existsSync(path.join(exportDir, "allure-history.jsonl"))).toBe(true);
    expect(existsSync(path.join(exportDir, "link.md"))).toBe(true);
    expect(existsSync(path.join(exportDir, "own.md"))).toBe(false);
  });

  it("keeps allure-history.jsonl when a manifest names it through a symlinked alias", async () => {
    const exportDir = path.join(stateDir(rootDir), "export");
    await mkdir(exportDir, { recursive: true });
    await writeFile(path.join(exportDir, "allure-history.jsonl"), '{"kept":true}\n');
    await symlink(".", path.join(exportDir, "alias"));
    await mkdir(path.join(stateDir(rootDir), "runs", "run-iii"), { recursive: true });
    await writeFile(path.join(stateDir(rootDir), "runs", "run-iii", "exports"), `${path.join(".nukadoko", "export", "alias", "allure-history.jsonl")}\n`);
    const stdout = createCaptureSink();
    expect(await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    expect(stdout.text()).toBe(`${path.join(".nukadoko", "runs", "run-iii")}\n`);
    expect(existsSync(path.join(exportDir, "allure-history.jsonl"))).toBe(true);
  });

  it("removes a manifest-named file whose name starts with two dots, since it is inside export/", async () => {
    await mkdir(path.join(stateDir(rootDir), "export"), { recursive: true });
    await writeFile(path.join(stateDir(rootDir), "export", "..messages.ndjson"), "line1\n");
    await mkdir(path.join(stateDir(rootDir), "runs", "run-eee"), { recursive: true });
    await writeFile(path.join(stateDir(rootDir), "runs", "run-eee", "exports"), `${path.join(".nukadoko", "export", "..messages.ndjson")}\n`);
    const stdout = createCaptureSink();
    expect(await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    expect(stdout.text()).toBe(`${path.join(".nukadoko", "runs", "run-eee")}\n${path.join(".nukadoko", "export", "..messages.ndjson")}\n`);
    expect(existsSync(path.join(stateDir(rootDir), "export", "..messages.ndjson"))).toBe(false);
  });

  it.each(["--records", "--cache", "--export"])("refuses %s by name, says clean removes every category, and deletes nothing", async (flag) => {
    await seedRecords(rootDir);
    await seedExport(rootDir);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean", flag], { rootDir, stdout, stderr });
    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      `refused\tremoved-flag\t-\tnuka clean ${flag} is removed: nuka clean always removes records and export together; ` +
        "nuka clean --dry-run lists what it would remove.\n  fix: Use what the message names in its place.\n",
    );
    expect(existsSync(path.join(stateDir(rootDir), "do", "step-aaa"))).toBe(true);
    expect(existsSync(path.join(stateDir(rootDir), "export", "allure-results", "some-result.json"))).toBe(true);
  });

  it("refuses a removed flag as one JSON object under --json", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["clean", "--cache", "--json"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toEqual({
      schema_version: 3,
      nukadoko: readOwnVersion(),
      command: "clean",
      verdict: "refused",
      findings: [
        {
          severity: "refused",
          code: "removed-flag",
          message:
            "nuka clean --cache is removed: nuka clean always removes records and export together; " +
            "nuka clean --dry-run lists what it would remove.",
          fix: "Use what the message names in its place.",
        },
      ],
    });
  });

  it("leaves a report written outside the state directory in place", async () => {
    await mkdir(path.join(rootDir, "reports", "allure"), { recursive: true });
    await writeFile(path.join(rootDir, "reports", "allure", "some-result.json"), "{}");
    await writeFile(path.join(rootDir, "reports", "messages.ndjson"), "line1\n");
    await seedExport(rootDir);

    const stdout = createCaptureSink();
    expect(await runCli(["clean"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    expect(stdout.text()).toBe(
      `${path.join(".nukadoko", "runs", "run-ccc")}\n${path.join(".nukadoko", "export", "allure-results")}\n${path.join(".nukadoko", "export", "messages.ndjson")}\n`,
    );
    expect(existsSync(path.join(rootDir, "reports", "allure", "some-result.json"))).toBe(true);
    expect(existsSync(path.join(rootDir, "reports", "messages.ndjson"))).toBe(true);
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
    expect(existsSync(path.join(stateDir(rootDir), "do", "step-aaa"))).toBe(true);
  });
});
