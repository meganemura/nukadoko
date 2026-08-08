import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run <dir>` end to end against run-directory-project
// (run-directory-target task spec) — a directory target folded into the
// same one invocation a single feature file already gets. run.test.ts
// covers everything about a single-file target (matching/skip/record
// mechanics); this file only covers what changes once the positional names
// a directory instead: multiple features in one invocation, deterministic
// file order, refusing an empty directory, and refusing `:line` on one.
// `nuka accept` after a directory run gets its own test in accept.test.ts,
// beside every other `nuka accept` end-to-end test.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run <dir>", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-directory-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs every .feature file under a directory in one invocation: one run_id, one summary, one exit code", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    // Trailing slash, matching README's own CI example verbatim (this
    // task's own "なぜ": README:566 becomes true once this runs).
    const exitCode = await runCli(["run", "features/multi/"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);

    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.feature).sort()).toEqual(["features/multi/alpha.feature", "features/multi/beta.feature"]);
    expect(records.every((r) => r.status === "passed")).toBe(true);

    // One run_id shared by every record in this invocation (this task's
    // spec, decision 5: N feature files flow into the same one run).
    const runIds = new Set(records.map((r) => r.run_id));
    expect(runIds.size).toBe(1);

    // One summary line, counting across both files (this task's spec,
    // decision 6: the progress counter runs through the whole invocation).
    expect(stderr.text()).toMatch(/^2 scenarios: 2 passed, 0 failed/m);
    expect(stderr.text()).toMatch(/scenario 1\/2 {2}features\/multi\/alpha\.feature:3/);
    expect(stderr.text()).toMatch(/scenario 2\/2 {2}features\/multi\/beta\.feature:3/);
  });

  it("walks a directory in deterministic byte order of the repo-relative path, not directory-then-file name order", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/order"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);

    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    // "features/order/a.feature" sorts before "features/order/a/x.feature"
    // in byte order ('.' is 0x2E, '/' is 0x2F) — a name-at-each-directory-
    // level walk (as src/feature/load-features.ts's own `walkFeatureFiles`
    // uses for `nuka check`/`nuka tend`) would instead recurse into
    // directory "a" before visiting sibling file "a.feature", producing the
    // opposite order. This is the one case that tells the two sorts apart.
    expect(records.map((r) => r.feature)).toEqual(["features/order/a.feature", "features/order/a/x.feature"]);
  });

  it("refuses a directory with no .feature file anywhere under it: non-zero exit, names what it walked, writes nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/empty"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).not.toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("features/empty");
    expect(stderr.text()).toContain(path.join(rootDir, "features", "empty"));
  });

  it("refuses :line on a directory target", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    // The exact shape this task's own spec calls out: `features/:12` names
    // no single file for `:line` to mean anything against.
    const exitCode = await runCli(["run", "features/:12"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).not.toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toMatch(/:line/);
    expect(stderr.text()).toContain("features/:12");
  });
});
