import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOpen, judgeWorkingTree } from "../src/cli/verdict.js";
import { runCli } from "../src/cli/run-cli.js";
import type { Finding } from "../src/finding/finding.js";
import type { RunDocument } from "../src/record/run-result.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka verdict`, end to end on a git project (its exact
// text and JSON for a missing, a judged, a stale, a red, and a partial
// run), and the properties of `judgeWorkingTree`, the pure answer behind
// it.

async function nuka(rootDir: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe("nuka verdict", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
    await writeFile(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    await initGitRepo(rootDir);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails with run-missing before any run ended, and prints the tree it has", async () => {
    const result = await nuka(rootDir, ["verdict", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const document = JSON.parse(result.stdout);
    expect(Object.keys(document)).toEqual([
      "schema_version",
      "nukadoko",
      "command",
      "verdict",
      "findings",
      "judged",
      "working_tree",
      "run_id",
      "run_dir",
      "run_working_tree",
      "base",
    ]);
    expect(document).toMatchObject({
      command: "verdict",
      verdict: "failed",
      findings: [{ severity: "failed", code: "run-missing", message: "no nuka run has ended in this project, so nothing judged this working tree", do: "nuka run" }],
      judged: "missing",
      working_tree: expect.stringMatching(/^[0-9a-f]{40}$/),
      run_id: null,
      run_dir: null,
      run_working_tree: null,
      base: null,
    });
  });

  it("passes after a run of the tree, notes a run without --base, and goes stale on an edit", async () => {
    expect((await nuka(rootDir, ["run", "--no-check", "features/passing.feature"])).exitCode).toBe(0);
    const run = latestRunJson(rootDir);

    const judged = await nuka(rootDir, ["verdict"]);
    expect(judged.exitCode).toBe(0);
    expect(judged.stderr).toBe("");
    expect(judged.stdout).toBe(
      [
        `passed: the newest run, ${run.run_id}, judged this working tree and left nothing red`,
        `note\trun-without-base\t-\tthe newest run ${run.run_id} had no --base, so no row says which criteria are new or changed, and a new one that passes without the change was not caught`,
        "  fix: No change is necessary. Run with --base and the commit the change started from to have new and changed criteria proven against it.",
        "",
      ].join("\n"),
    );

    await appendFile(path.join(rootDir, "features", "passing.feature"), "\n");
    const stale = await nuka(rootDir, ["verdict", "--json"]);
    expect(stale.exitCode).toBe(1);
    const document = JSON.parse(stale.stdout);
    const then = run.commit.working_tree as string;
    const now = document.working_tree as string;
    expect(now).not.toBe(then);
    expect(document).toMatchObject({ verdict: "failed", judged: "stale", run_id: run.run_id, run_working_tree: then });
    expect(document.findings).toEqual([
      {
        severity: "failed",
        code: "run-stale",
        message: `the newest run ${run.run_id} (started ${run.started_at}) judged working tree ${then.slice(0, 12)}, and the working tree is now ${now.slice(0, 12)}: its verdicts say nothing about what changed since`,
        do: "nuka run",
      },
    ]);

    const text = await nuka(rootDir, ["verdict"]);
    expect(text.stdout.split("\n")[0]).toBe(`failed: the newest run, ${run.run_id}, judged another working tree`);
  });

  it("relays a red run's own failed findings, as run.json holds them", async () => {
    expect((await nuka(rootDir, ["run", "--no-check", "features/failing.feature"])).exitCode).toBe(1);
    const run = latestRunJson(rootDir);
    const result = await nuka(rootDir, ["verdict", "--json"]);
    expect(result.exitCode).toBe(1);
    const document = JSON.parse(result.stdout);
    expect(document.judged).toBe("judged");
    const red = (run.findings as Finding[]).filter((finding) => finding.severity === "failed");
    expect(red.map((finding) => finding.code)).toContain("scenario-failed");
    expect(document.findings.filter((finding: Finding) => finding.severity === "failed")).toEqual(red);
  });

  it("fails a run that left out scenarios of its file with run-partial", async () => {
    expect((await nuka(rootDir, ["run", "--no-check", "features/lines.feature:3"])).exitCode).toBe(0);
    const run = latestRunJson(rootDir);
    const result = await nuka(rootDir, ["verdict"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.split("\n").slice(0, 3)).toEqual([
      `failed: the newest run, ${run.run_id}, judged this working tree, and it leaves open what is below`,
      `failed\trun-partial\t-\tthe newest run ${run.run_id} left out scenarios of the files it named (a :line target or --tag), so the criteria it left out were not judged`,
      "  do: nuka run",
    ]);
  });
});

// A run.json reduced to the fields the answer reads.
const TREE = gs.text({ minSize: 40, maxSize: 40, alphabet: "0123456789abcdef" });
const redFinding: gs.Generator<Finding> = gs
  .tuples(gs.sampledFrom(["failed", "error", "warning", "note"] as const), gs.sampledFrom(["scenario-failed", "criterion-unproven", "hook-failed", "program-exited"]))
  .map(([severity, code]) => ({ severity, code, message: `${code} happened`, do: "nuka run" }));
const runDocument: gs.Generator<RunDocument> = gs
  .tuples(
    gs.oneOf(TREE.map((tree): string | undefined => tree), gs.just(undefined)),
    gs.arrays(redFinding, { maxSize: 4 }),
    gs.booleans(),
    gs.sampledFrom(["full", "partial"] as const),
    gs.booleans(),
    gs.oneOf(gs.just(null), gs.just({ ref: "main", commit: "0".repeat(40) })),
    gs.arrays(gs.sampledFrom(["new", "changed", "unchanged"] as const), { maxSize: 4 }),
  )
  .map(
    ([tree, findings, failedWithout, selection, walked, base, changes]) =>
      ({
        run_id: "run-20261103-000000-abcd",
        run_dir: ".nukadoko/runs/run-20261103-000000-abcd",
        started_at: "2026-11-03T00:00:00.000Z",
        commit: { sha: "1".repeat(40), dirty: true, ...(tree === undefined ? {} : { working_tree: tree }) },
        verdict: findings.some((finding) => finding.severity === "failed" || finding.severity === "error") || failedWithout ? "failed" : "passed",
        findings,
        selection,
        ...(walked ? { walk: { pauses: [] } } : {}),
        table: { base, rows: changes.map((change) => ({ change })) },
      }) as unknown as RunDocument,
  );

describe("judgeWorkingTree", () => {
  it(
    "passes only when the newest run judged this tree (or the tree is unknown) and is a full, green run",
    () => hegel.test((tc) => {
      const newest = tc.draw(gs.oneOf(runDocument.map((run): RunDocument | undefined => run), gs.just(undefined)));
      const sameTree = tc.draw(gs.booleans());
      const workingTree = tc.draw(
        gs.oneOf(
          TREE.map((tree): string | undefined => (sameTree ? ((newest?.commit as { working_tree?: string } | null)?.working_tree ?? tree) : tree)),
          gs.just(undefined),
        ),
      );
      const answer = judgeWorkingTree(newest, workingTree);
      const recorded = (newest?.commit as { working_tree?: string } | null)?.working_tree;
      const passes =
        newest !== undefined &&
        (workingTree === undefined || recorded === workingTree) &&
        newest.verdict === "passed" &&
        newest.selection === "full" &&
        newest.walk === undefined;
      expect(isOpen(answer.findings)).toBe(!passes);
    }),
  );

  it(
    "says nothing of a stale run's table: one run-stale finding, and that is all",
    () => hegel.test((tc) => {
      const newest = tc.draw(runDocument);
      const workingTree = tc.draw(TREE);
      const recorded = (newest.commit as { working_tree?: string }).working_tree;
      tc.assume(recorded !== workingTree);
      const answer = judgeWorkingTree(newest, workingTree);
      expect(answer.judged).toBe("stale");
      expect(answer.findings.map((finding) => finding.code)).toEqual(["run-stale"]);
    }),
  );

  it(
    "relays every failed and error finding of a run that judged this tree, unchanged and in order",
    () => hegel.test((tc) => {
      const newest = tc.draw(runDocument);
      const recorded = (newest.commit as { working_tree?: string }).working_tree;
      const answer = judgeWorkingTree(newest, recorded);
      const red = newest.findings.filter((finding) => finding.severity === "failed" || finding.severity === "error");
      const relayed = answer.findings.filter((finding) => newest.findings.includes(finding));
      expect(relayed).toEqual(red);
      expect(answer.judged).toBe(recorded === undefined ? "unknown" : "judged");
    }),
  );
});
