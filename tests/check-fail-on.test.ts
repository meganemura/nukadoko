import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOnHits } from "../src/cli/check.js";
import { runCli } from "../src/cli/run-cli.js";
import type { CheckCode } from "../src/check/codes.js";
import type { CheckFinding, CheckReport } from "../src/check/types.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `nuka check --fail-on <code>`: a chosen code turns the exit
// code to 1 for that invocation, the finding keeps its severity, and a code
// a check report never contains is refused before anything is analyzed.

describe("nuka check --fail-on", () => {
  let rootDir: string;

  beforeEach(async () => {
    // pure-step-project: two steps with undescribed schema fields, so
    // schema-field-undescribed fires twice, beside three
    // scenario-without-then warnings and no error.
    rootDir = await copyFixtureToTempDir("pure-step-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("exits 0 with notes and warnings alone", async () => {
    const stderr = createCaptureSink();
    expect(await runCli(["check"], { rootDir, stdout: createCaptureSink(), stderr })).toBe(0);
    expect(stderr.text()).toBe("");
  });

  it("exits 1 when a finding with the code is reported, says so on stderr, and keeps the finding a note", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--fail-on", "schema-field-undescribed"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toBe("fail-on: schema-field-undescribed reported 2 findings\n");
    expect(stdout.text()).toMatch(/^note\tschema-field-undescribed\t/m);
    expect(stdout.text()).not.toMatch(/^error\t/m);
  });

  it("gates on a warning code the same way, and the finding stays a warning", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    expect(await runCli(["check", "--fail-on", "scenario-without-then"], { rootDir, stdout, stderr })).toBe(1);
    expect(stderr.text()).toBe("fail-on: scenario-without-then reported 3 findings\n");
    expect(stdout.text()).toMatch(/^warning\tscenario-without-then\t/m);
  });

  it("exits 0 when the code is valid but nothing reported it", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--fail-on", "fixture-unused"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).not.toContain("fail-on:");
  });

  it("refuses a code nuka check never reports, pointing at nuka check --codes", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--fail-on", "pattern-unbond"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      'refused\tfail-on-unknown-code\t-\t--fail-on: "pattern-unbond" is not a code nuka check reports\n' +
        "  fix: Name an error, warning, or note code that nuka check --codes lists.\n  do: nuka check --codes\n",
    );
  });

  it("refuses a run code that --codes lists, saying a check report never contains it", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--fail-on", "repeated-scenario-prefix,ghost-code"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.text().split("\n")[0]).toBe(
      'refused\tfail-on-unknown-code\t-\t--fail-on: "ghost-code" is not a code nuka check reports; ' +
        '"repeated-scenario-prefix" is a nuka run or refusal code, which a check report never contains',
    );
  });

  it("refuses before analysis, so a project whose config does not load still gets the refusal", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--fail-on", "pattern-unbond"], {
      rootDir: fixture("invalid-config-project"),
      stdout: createCaptureSink(),
      stderr,
    });
    expect(exitCode).toBe(2);
    expect(stderr.text()).toMatch(/^refused\tfail-on-unknown-code\t/);
  });

  it("takes a comma-separated list and a repeated flag alike", async () => {
    const commaErr = createCaptureSink();
    expect(
      await runCli(["check", "--fail-on", "fixture-unused,schema-field-undescribed"], { rootDir, stdout: createCaptureSink(), stderr: commaErr }),
    ).toBe(1);
    expect(commaErr.text()).toBe("fail-on: schema-field-undescribed reported 2 findings\n");

    const repeatedErr = createCaptureSink();
    expect(
      await runCli(["check", "--fail-on", "fixture-unused", "--fail-on", "schema-field-undescribed"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: repeatedErr,
      }),
    ).toBe(1);
    expect(repeatedErr.text()).toBe("fail-on: schema-field-undescribed reported 2 findings\n");
  });

  it("takes one value per flag, so a feature path after it is a target", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--fail-on", "scenario-without-then", "features/multi.feature"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toBe("fail-on: scenario-without-then reported 2 findings\n");
  });

  it("keeps --json output parseable while the exit code turns to 1, and names each hit in fail_on_hits", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json", "--fail-on", "schema-field-undescribed,fixture-unused"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(1);
    const report = bySeverity(stdout.text());
    expect(report.verdict).toBe("failed");
    expect(report.fail_on_hits).toEqual([{ code: "schema-field-undescribed", count: 2 }]);
    expect(report.notes.map((issue: { code: string; step: string }) => [issue.code, issue.step])).toEqual([
      ["schema-field-undescribed", "visitor-arrives"],
      ["schema-field-undescribed", "visitor-greeted"],
    ]);
  });

  it("carries an empty fail_on_hits under --json when no --fail-on code fired", async () => {
    const stdout = createCaptureSink();
    expect(await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    expect(bySeverity(stdout.text()).fail_on_hits).toEqual([]);
  });
});

describe("failOnHits", () => {
  const CODES: readonly CheckCode[] = ["pattern-unbound", "fixture-unused", "scenario-without-then", "undefined-step"];
  const finding = (code: CheckCode): CheckFinding => ({ code, message: code });

  it("names exactly the listed codes the report holds, once each, in the order first listed, with their count across every severity", () =>
    hegel.test((tc) => {
      const bucket = () => tc.draw(gs.arrays(gs.sampledFrom([...CODES]), { maxSize: 5 })).map(finding);
      const report: CheckReport = { errors: bucket(), warnings: bucket(), notes: bucket() };
      const failOn = tc.draw(gs.arrays(gs.sampledFrom([...CODES]), { maxSize: 6 }));
      const all = [...report.errors, ...report.warnings, ...report.notes];
      const hits = failOnHits(report, failOn);

      for (const hit of hits) {
        expect(hit.count).toBe(all.filter((issue) => issue.code === hit.code).length);
      }
      const present = failOn.filter((code, index) => failOn.indexOf(code) === index && all.some((issue) => issue.code === code));
      expect(hits.map((hit) => hit.code)).toEqual(present);
    }));
});
