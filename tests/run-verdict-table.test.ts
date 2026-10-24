import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { JUnitXmlPrinter } from "@cucumber/junit-xml-formatter";
import { parseEnvelope } from "@cucumber/messages";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the verdict table a real run writes, against
// tests/fixtures/run-verdict-project. Its flag-off and flag-on
// environments declare the condition `banner` off and on, and staging
// declares none, so a run with no --env runs flag-off and flag-on. A
// scenario tagged for one side is a control on the other, where its Then
// breaks, and the control proves it after `--proof-runs` agreeing
// failures. The exact run.json `table`, the summary's table, the stderr
// lines, the counts, and the refusal of a `--proof-runs` that is not a
// whole number of 1 or more; at --concurrency 1 and 2 alike. And what the
// Allure results and the messages stream carry of each execution's row.

async function run(argv: readonly string[]) {
  const rootDir = await copyFixtureToTempDir("run-verdict-project");
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  try {
    const exitCode = await runCli(["run", ...argv], { rootDir, stdout, stderr });
    const document = exitCode === 2 ? {} : latestRunJson(rootDir);
    const summary = exitCode === 2 ? "" : readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    return { exitCode, document, summary, stderr: stderr.text(), stdout: stdout.text() };
  } finally {
    await removeTempDir(rootDir);
  }
}

const head = (environment: string) => ({ world: "head", environment });
// A cell names the conditions its row's tags name, with the value its
// environment declares: banner is off in flag-off and on in flag-on.
const banner = (environment: string) => ({ banner: environment === "flag-on" });
const pass = (environment: string, role: "required" | "control", runs = 1, conditions: Record<string, boolean> = banner(environment)) => ({
  ...head(environment),
  role,
  conditions,
  outcome: "pass",
  runs,
});
// A control breaks the step's one claim, reading the banner the other way.
const fail = (environment: string, line: number, runs: number) => ({
  ...head(environment),
  role: "control",
  conditions: banner(environment),
  outcome: "fail",
  line,
  runs,
  claim: 0,
  actuals: Array.from({ length: runs }, () => ({ value: environment === "flag-on" ? "on" : "off" })),
});

function table(proofRuns: number) {
  return {
    base: null,
    mapping_changed: null,
    worlds: [head("flag-off"), head("flag-on")],
    rows: [
      {
        feature: "features/banner.feature",
        line: 4,
        name: "the banner is on",
        change: null,
        conditions: ["@with:banner"],
        cells: [fail("flag-off", 5, proofRuns), pass("flag-on", "required")],
        verdict: "proven",
        reason: `passes in flag-on, and a claim broke at line 5 in flag-off, where its conditions do not hold, in each of ${proofRuns} runs`,
      },
      {
        feature: "features/banner.feature",
        line: 8,
        name: "the banner is off",
        change: null,
        conditions: ["@without:banner"],
        cells: [pass("flag-off", "required"), fail("flag-on", 9, proofRuns)],
        verdict: "proven",
        reason: `passes in flag-off, and a claim broke at line 9 in flag-on, where its conditions do not hold, in each of ${proofRuns} runs`,
      },
      {
        feature: "features/value.feature",
        line: 3,
        name: "the banner has a value",
        change: null,
        conditions: [],
        cells: [pass("flag-off", "required", 1, {}), pass("flag-on", "required", 1, {})],
        verdict: "held",
        reason: "passes in flag-off, flag-on",
      },
      {
        feature: "features/value.feature",
        line: 7,
        name: "the banner has a value where it is on",
        change: null,
        conditions: ["@with:banner", "@held"],
        cells: [pass("flag-off", "control"), pass("flag-on", "required")],
        verdict: "held",
        reason: "passes in flag-on; no control shows a Then failing where its conditions do not hold (flag-off: pass)",
      },
    ],
    left_out: 0,
    proof_runs: proofRuns,
  };
}

describe("nuka run: the verdict table", () => {
  for (const concurrency of ["1", "2"]) {
    it(`selects every environment that declares conditions, and proves a gated scenario with a control, at --concurrency ${concurrency}`, async () => {
      const { exitCode, document, summary, stderr } = await run(["--concurrency", concurrency]);
      expect(exitCode).toBe(0);
      expect(document.verdict).toBe("passed");
      expect(document.environments).toEqual([
        { name: "flag-off", target_version: null, base_url: null, conditions: { banner: false } },
        { name: "flag-on", target_version: null, base_url: null, conditions: { banner: true } },
      ]);
      expect(document.table).toEqual(table(2));
      expect(document.counts).toEqual({ scenarios: 5, passed: 5, failed: 0, not_run: 0, controls: 5, controls_not_run: 0 });
      expect(document.findings).toEqual([]);
      // A control's failure is proof, not a failure to rerun.
      const controls = (document.scenarios as { role: string; do?: string; status: string }[]).filter((entry) => entry.role === "control");
      expect(controls.map((entry) => [entry.status, entry.do])).toEqual(
        expect.arrayContaining([
          ["failed", undefined],
          ["passed", undefined],
        ]),
      );
      expect(controls).toHaveLength(5);
      expect(summary.split("\n").slice(1, 9)).toEqual([
        "# nukadoko run passed: 4 criteria in 2 environments, 2 held, 2 proven",
        "",
        "| verdict | criterion | head flag-off (banner: false) | head flag-on (banner: true) |",
        "| --- | --- | --- | --- |",
        "| proven | `features/banner.feature:4` the banner is on `@with:banner` | fail@5 (control, 2 runs) | pass |",
        "| proven | `features/banner.feature:8` the banner is off `@without:banner` | pass | fail@9 (control, 2 runs) |",
        "| held | `features/value.feature:3` the banner has a value | pass | pass |",
        "| held | `features/value.feature:7` the banner has a value where it is on `@with:banner` `@held` | pass (control) | pass |",
      ]);
      expect(stderr.split("\n").filter((line) => line.startsWith("proof run "))).toEqual([
        "proof run 2/2  features/banner.feature:4  the banner is on  (control in flag-off)",
        "proof run 2/2  features/banner.feature:8  the banner is off  (control in flag-on)",
      ]);
      expect(stderr).toMatch(/^scenario \d\/8 {2}features\/banner\.feature:4 {2}the banner is on {2}\(control\)$/m);
      expect(stderr).toMatch(/^5 scenarios: 5 passed, 0 failed {2}\(\d+s\)\n5 control runs\ncriteria: 2 held, 2 proven, 0 failed\n/m);
      // A control's claims are marked as a control's, and the default
      // --proof-runs is not named.
      expect(summary).toContain("\n- `features/banner.feature:5` the banner reads \"on\" (flag-off, control)\n  - \"off\" (observe:banner) equal \"on\" (sentence:state) broken; measured: none\n");
      expect(summary).toContain("\n- `features/banner.feature:5` the banner reads \"on\" (flag-on)\n");
      expect(summary).toContain(" An entry marked `control` is a control's: a claim it broke is evidence that the scenario tells the behaviour apart, not a failure.\n");
      expect(summary).not.toContain("proof runs:");
    });
  }

  it("runs a control until --proof-runs agreeing failures, and no further", async () => {
    const { exitCode, document, summary } = await run(["features/banner.feature:4", "--proof-runs", "3"]);
    expect(exitCode).toBe(0);
    expect(document.table.rows).toEqual([table(3).rows[0]]);
    expect(document.table.proof_runs).toBe(3);
    expect(summary).toContain("\n- proof runs: 3 (`--proof-runs`: a control proves its row once it breaks the same claim at one Then line in 3 runs)\n");
    expect((document.scenarios as unknown[]).length).toBe(4);
  });

  it("runs a required cell --repeat times and a control no fewer than --proof-runs", async () => {
    const { document } = await run(["features/banner.feature:4", "--repeat", "3"]);
    expect(document.table.rows[0].cells).toEqual([fail("flag-off", 5, 3), pass("flag-on", "required", 3)]);
  });

  it("leaves out a row --env gives no required cell, under --no-check too, and does not turn the run red", async () => {
    const { exitCode, document, summary } = await run(["features/banner.feature", "--env", "flag-on", "--no-check"]);
    expect(exitCode).toBe(0);
    expect(document.verdict).toBe("passed");
    expect(document.counts).toEqual({ scenarios: 1, passed: 1, failed: 0, not_run: 0, controls: 0, controls_not_run: 0 });
    expect(document.table.rows.map((row: { line: number; verdict: string; reason: string }) => [row.line, row.verdict, row.reason])).toEqual([[4, "held", "passes in flag-on"]]);
    expect(document.table.left_out).toBe(1);
    expect(summary.split("\n").slice(1, 3)).toEqual(["# nukadoko run passed: 1 criterion, 1 held", ""]);
    expect(summary).toContain("\n1 criterion not run: its conditions hold in no selected environment\n");
  });

  it("runs an environment that declares no conditions only when --env names it", async () => {
    const { document } = await run(["features/value.feature:3", "--env", "staging"]);
    expect(document.table.worlds).toEqual([head("staging")]);
    expect(document.table.rows.map((row: { verdict: string }) => row.verdict)).toEqual(["held"]);
  });

  it("keeps each control in the Allure results with its own status, marked as a control, and carries the row's verdict", async () => {
    const rootDir = await copyFixtureToTempDir("run-verdict-project");
    try {
      const cli = (argv: string[], stdout = createCaptureSink()) => runCli(argv, { rootDir, stdout, stderr: createCaptureSink() });
      expect(await cli(["run", "features/banner.feature:4"])).toBe(0);

      expect(await cli(["report", "--format", "allure"])).toBe(0);
      const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
      type Result = { status: string; name: string; fullName: string; historyId: string; labels: { name: string; value: string }[]; parameters: { name: string; value: string; excluded?: boolean }[] };
      const read = readdirSync(resultsDir)
        .filter((name) => name.endsWith("-result.json"))
        .map((name) => JSON.parse(readFileSync(path.join(resultsDir, name), "utf8")) as Result);
      const results = read
        .map((result) => [
          result.status,
          result.name,
          ...result.labels.filter((label) => label.name === "role").map((label) => `role=${label.value}`),
          ...result.parameters.filter((parameter) => ["environment", "verdict", "role"].includes(parameter.name)).map((parameter) => `${parameter.name}=${parameter.value}${parameter.excluded === true ? " (excluded)" : ""}`),
        ])
        .sort((a, b) => a.join().localeCompare(b.join()));
      expect(results).toEqual([
        ["failed", "the banner is on (control)", "role=control", "verdict=proven (excluded)", "environment=flag-off"],
        ["failed", "the banner is on (control)", "role=control", "verdict=proven (excluded)", "environment=flag-off"],
        ["passed", "the banner is on", "role=required", "verdict=proven (excluded)", "environment=flag-on"],
      ]);
      // The name is not identity: fullName keeps the bare name for every
      // cell, and the two proof runs of one control share a history.
      expect(new Set(read.map((result) => result.fullName)).size).toBe(1);
      expect(new Set(read.filter((result) => result.name.endsWith("(control)")).map((result) => result.historyId)).size).toBe(1);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("leaves every control execution out of the messages stream, so JUnit reads a green run with proven rows as green", async () => {
    const rootDir = await copyFixtureToTempDir("run-verdict-project");
    try {
      const cli = (argv: string[], stdout = createCaptureSink()) => runCli(argv, { rootDir, stdout, stderr: createCaptureSink() });
      expect(await cli(["run"])).toBe(0);
      const out = createCaptureSink();
      expect(await cli(["report", "--format", "messages"], out)).toBe(0);
      const lines = out
        .text()
        .split("\n")
        .filter((line) => line.length > 0);
      const envelopes = lines.map(
        (line) =>
          JSON.parse(line) as {
            attachment?: { mediaType: string; body: string; testStepId?: string; fileName: string };
            testCaseStarted?: unknown;
            pickle?: { name: string };
            testRunFinished?: { success: boolean };
          },
      );
      // 8 executions ran, 3 of them controls (two proof runs each for two
      // rows, and one passing control), which leaves the 5 required ones.
      expect(envelopes.filter((envelope) => envelope.testCaseStarted !== undefined)).toHaveLength(5);
      const verdicts = envelopes.flatMap((envelope) => (envelope.attachment?.mediaType === "application/vnd.nukadoko.verdict+json" ? [envelope.attachment] : []));
      expect(verdicts.map((attachment) => [attachment.fileName, attachment.testStepId])).toEqual(Array.from({ length: 5 }, () => ["verdict.json", undefined]));
      // The required cell of a proven row still says the row is proven.
      expect(verdicts.map((attachment) => JSON.parse(attachment.body))).toContainEqual({ verdict: "proven", reason: table(2).rows[0]!.reason });
      expect(envelopes.at(-1)!.testRunFinished?.success).toBe(true);
      let xml = "";
      const printer = new JUnitXmlPrinter({}, (content) => {
        xml += content;
      });
      for (const line of lines) printer.update(parseEnvelope(line));
      expect(xml).toMatch(/<testsuite [^>]*tests="5"/);
      expect(xml).toMatch(/<testsuite [^>]*failures="0"/);
      expect(xml).not.toContain("<failure");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  for (const value of ["0", "1.5", "-2"]) {
    it(`refuses --proof-runs ${value}, and runs nothing`, async () => {
      const { exitCode, stderr, stdout } = await run(["--proof-runs", value]);
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(`refused\tinvalid-value\t-\t--proof-runs must be a whole number of 1 or more (got ${value}).\n`);
    });
  }
});
