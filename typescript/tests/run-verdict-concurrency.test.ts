import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: what a failed run hook does to a run under
// --concurrency, against tests/fixtures/run-verdict-hooks-project. A proof
// round starts a worker of its own, which runs BeforeAll and AfterAll
// again; a hook that fails there makes the round's control cell broke,
// with the reason and a proof-run-incomplete warning, and never turns the
// run red. Outside the proof rounds, a worker's failed AfterAll fails the
// run, as it does at --concurrency 1.

interface Finding {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
}

interface Cell {
  readonly environment: string;
  readonly role: string;
  readonly outcome: string;
  readonly line?: number;
  readonly runs: number;
  readonly reason?: string;
}

async function run(hooks: object, argv: readonly string[]) {
  const rootDir = await copyFixtureToTempDir("run-verdict-hooks-project");
  try {
    writeFileSync(path.join(rootDir, "hooks.json"), JSON.stringify(hooks));
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", ...argv], { rootDir, stdout: createCaptureSink(), stderr });
    const document = latestRunJson(rootDir) as {
      verdict: string;
      findings: Finding[];
      table: { rows: { line: number; feature: string; verdict: string; cells: Cell[] }[] };
    };
    return { exitCode, document, stderr: stderr.text() };
  } finally {
    await removeTempDir(rootDir);
  }
}

const bannerOn = (document: Awaited<ReturnType<typeof run>>["document"]) =>
  document.table.rows.find((row) => row.feature === "features/banner.feature" && row.line === 4)!;

describe("nuka run --concurrency 2: a failed run hook", () => {
  // Calls 1 and 2 of each hook are flag-off's two workers, and call 3 is
  // the worker of flag-off's proof round, which runs the control
  // features/banner.feature:4 again.
  for (const [hook, hooks] of [
    ["BeforeAll", { beforeAll: [3] }],
    ["AfterAll", { afterAll: [3] }],
  ] as const) {
    it(`in a proof round's worker (${hook}) makes only its control cell broke, and the run stays green`, async () => {
      const { exitCode, document, stderr } = await run(hooks, ["--concurrency", "2"]);
      expect(exitCode).toBe(0);
      expect(document.verdict).toBe("passed");
      expect(document.findings.filter((finding) => finding.severity === "failed")).toEqual([]);
      const reason = `the worker of its proof run failed: ${hook} failed in environment "flag-off": ${hook} call 3 fails`;
      expect(bannerOn(document).cells[0]).toEqual({
        world: "head",
        environment: "flag-off",
        role: "control",
        conditions: { banner: false },
        outcome: "broke",
        line: 4,
        runs: hook === "BeforeAll" ? 1 : 2,
        reason,
      });
      expect(bannerOn(document).verdict).toBe("held");
      // The other environment's proof round is untouched.
      expect(document.table.rows.find((row) => row.line === 8)!.verdict).toBe("proven");
      expect(stderr).toContain(
        `warning\tproof-run-incomplete\t-\tA proof round in environment "flag-off" did not finish: ${reason}. ` +
          "The control cell it was given (features/banner.feature:4) reads broke and proves nothing, so a row it would have proven reads as one no control proves\n",
      );
      expect(stderr).not.toContain("run-incomplete\t-\tA worker");
    });
  }

  it("outside the proof rounds (AfterAll) fails the run, as at --concurrency 1", async () => {
    const { exitCode, document } = await run({ afterAll: true }, ["--concurrency", "2", "--env", "flag-on", "features/banner.feature:4", "features/value.feature:3"]);
    expect(exitCode).toBe(1);
    expect(document.verdict).toBe("failed");
    expect(document.findings.filter((finding) => finding.code === "hook-failed").map((finding) => finding.severity)).toEqual(["failed", "failed"]);
    expect(document.table.rows.map((row) => row.verdict)).toEqual(["held", "held"]);
  });
});
