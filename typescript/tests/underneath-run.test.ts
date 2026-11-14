import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a scenario whose claims all held, over a program that
// failed underneath its steps, end to end against tests/fixtures/
// underneath-project: a 5xx response and an error the program reported
// with handled: false each turn its cell broke, so its row is failed and
// the run exits 1, with an `unexpected-failure` finding that spells the
// tag; a scenario that names the failure with an @expects: tag stays held;
// an error the program handled is no failure; a tag that matched nothing
// gets an `expects-unseen` note, and none where a page's script was left
// out of http.jsonl, whose status the run never kept; and `--concurrency`
// judges the same.

interface Finding {
  readonly severity: string;
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
  readonly fix?: string;
}

// Without --json, so the progress a person reads is written too; the
// findings are run.json's.
async function run(rootDir: string, argv: readonly string[] = []): Promise<{ exitCode: number; findings: readonly Finding[]; stderr: string }> {
  const stderr = createCaptureSink();
  const exitCode = await runCli(["run", ...argv], { rootDir, stdout: createCaptureSink(), stderr });
  return { exitCode, findings: latestRunJson(rootDir).findings as readonly Finding[], stderr: stderr.text() };
}

type Row = { line: number; verdict: string; expects?: string[]; cells: { outcome: string; line?: number; reason?: string }[] };

function rows(rootDir: string): { line: number; verdict: string; expects?: string[]; cells: string[] }[] {
  return (latestRunJson(rootDir).table.rows as Row[]).map((row) => ({
    line: row.line,
    verdict: row.verdict,
    ...(row.expects === undefined ? {} : { expects: row.expects }),
    cells: row.cells.map((cell) => [cell.outcome, cell.line, cell.reason].filter((part) => part !== undefined).join(" ")),
  }));
}

const JUDGED = [
  { line: 3, verdict: "failed", cells: ["broke 4 the step at line 4 got a 500 response to GET /broken, which no @expects tag of the scenario names"] },
  {
    line: 7,
    verdict: "failed",
    cells: ["broke 8 the program reported an unhandled Ledger::Stale in the trace of the step at line 8, which no @expects tag of the scenario names"],
  },
  { line: 11, verdict: "held", cells: ["pass"] },
  { line: 16, verdict: "held", expects: ["@expects:status=500", "@expects:error=Boom::Exploded"], cells: ["pass"] },
  { line: 21, verdict: "held", expects: ["@expects:status=503"], cells: ["pass"] },
];

describe("nuka run: failures underneath", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("underneath-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("turns a pass broke for a 5xx or an unhandled error no tag names, and keeps a scenario that names them held", async () => {
    const { exitCode, findings, stderr } = await run(rootDir);
    expect(exitCode).toBe(1);
    const document = latestRunJson(rootDir);
    // Every step passed: the claims held, and the cell says what they stood on.
    expect(document.scenarios.map((scenario: { status: string }) => scenario.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(rows(rootDir)).toEqual(JUDGED);
    const unexpected = findings.filter((finding) => finding.code === "unexpected-failure");
    expect(unexpected.map(({ file, line, fix }) => ({ file, line, fix }))).toEqual([
      {
        file: "features/underneath.feature",
        line: 4,
        fix: "Fix what failed. A scenario that causes it on purpose names it on its Scenario line: @expects:status=500 @expects:error=Boom::Exploded",
      },
      { file: "features/underneath.feature", line: 8, fix: "Fix what failed. A scenario that causes it on purpose names it on its Scenario line: @expects:error=Ledger::Stale" },
    ]);
    expect(unexpected[0]!.message).toMatch(
      /^a page that answers 500: its steps passed, and the program failed underneath the step at line 4, "the client gets \\"\/broken\\"", in a way no @expects tag names, so its cell is broke: 1 response with status 500, first GET http:\/\/localhost:\d+\/broken \(fetch, http\.jsonl\[0\]\); 1 line of the program's execution events reporting an unhandled Boom::Exploded; record steps\/step-/,
    );
    expect(findings.filter((finding) => finding.code === "expects-unseen")).toEqual([]);
    // The scenario count says every step passed; the criteria line under it
    // says what the table made of them.
    expect(stderr).toContain("5 scenarios: 5 passed, 0 failed");
    expect(stderr).toContain("criteria: 3 held, 0 proven, 2 failed\n");
    const summary = readFileSync(path.join(rootDir, document.run_dir as string, "summary.md"), "utf8");
    expect(summary).toContain("| failed | `features/underneath.feature:3` a page that answers 500 | broke@4 |");
    expect(summary).toContain("| held | `features/underneath.feature:21` a maintenance page `@expects:status=503` | pass |");
    expect(summary).toMatch(
      /\n {2}- step "the client gets "\/broken"": `1 response with status 500, first GET http:\/\/localhost:\d+\/broken \(fetch, http\.jsonl\[0\]\); 1 line of the program's execution events reporting an unhandled Boom::Exploded`; record `steps\/step-/,
    );
  });

  it("judges the same under --concurrency", async () => {
    expect((await run(rootDir, ["--concurrency", "2"])).exitCode).toBe(1);
    expect(rows(rootDir)).toEqual(JUDGED);
  });

  it("notes a tag that matched nothing, where the run saw every response and event of its kind", async () => {
    await writeFile(
      path.join(rootDir, "features", "underneath.feature"),
      ["Feature: tags", "", "  @expects:status=503 @expects:error=Ledger::Stale", "  Scenario: a request the program rescued", '    When the client gets "/rescued"', "    Then the program answered 200", ""].join("\n"),
    );
    const { exitCode, findings } = await run(rootDir);
    expect(exitCode).toBe(0);
    expect(rows(rootDir)).toEqual([{ line: 4, verdict: "held", expects: ["@expects:status=503", "@expects:error=Ledger::Stale"], cells: ["pass"] }]);
    expect(findings.filter((finding) => finding.code === "expects-unseen").map(({ severity, line, message }) => ({ severity, line, message }))).toEqual([
      { severity: "note", line: 4, message: "a request the program rescued: @expects:status=503 accepts a failure that did not happen: no step got a 503 response in its execution" },
      {
        severity: "note",
        line: 4,
        message: "a request the program rescued: @expects:error=Ledger::Stale accepts a failure that did not happen: the program reported no unhandled Ledger::Stale in its execution",
      },
    ]);
  });

  it("notes no status tag where a page's request was left out of http.jsonl, since its status was not kept", async () => {
    await writeFile(
      path.join(rootDir, "features", "underneath.feature"),
      ["Feature: tags", "", "  @expects:status=503", "  Scenario: a page whose script is down", '    When the visitor opens "/page"', ""].join("\n"),
    );
    const { exitCode, findings } = await run(rootDir);
    expect(exitCode).toBe(0);
    // The document answered 200 and is on http.jsonl; the script answered
    // 503 and is only counted as left out.
    const [step] = latestRunJson(rootDir).scenarios[0].steps;
    expect(step.status).toBe("passed");
    expect(step.underneath).toEqual({ unseen: { http_omitted: 1 } });
    expect(findings.filter((finding) => finding.code === "expects-unseen")).toEqual([]);
  });
});
