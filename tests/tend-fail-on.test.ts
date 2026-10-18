import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { tendCommandWithout } from "../src/cli/tend.js";
import { REMOVED_TEND_CODES, TEND_CODES } from "../src/tend/types.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, repoRoot } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `nuka tend --fail-on <code>`: a chosen note turns the exit
// code red for that invocation, the finding itself stays a note, a code
// tend never emits is refused up front (one an earlier release emitted is
// refused by name, with what replaced it), and the list the flag is checked
// against is the list of codes the tend sources actually emit.

describe("TEND_CODES", () => {
  it("equals every code literal under src/tend/", () => {
    const dir = path.join(repoRoot, "src", "tend");
    const literals = new Set<string>();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      for (const match of readFileSync(path.join(dir, name), "utf8").matchAll(/code: "([a-z0-9-]+)"/g)) {
        literals.add(match[1]!);
      }
    }
    expect([...TEND_CODES].sort()).toEqual([...literals].sort());
  });

  it("shares no code with REMOVED_TEND_CODES", () => {
    expect([...REMOVED_TEND_CODES.keys()].filter((code) => TEND_CODES.has(code))).toEqual([]);
  });
});

describe("nuka tend --fail-on", () => {
  let rootDir: string;

  beforeEach(async () => {
    // pure-step-project: two steps with undescribed schema fields, so
    // schema-field-undescribed fires twice and nothing here is red.
    rootDir = await copyFixtureToTempDir("pure-step-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("exits 1 when a finding with the code is reported, says so on stderr, and keeps the finding a note", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--fail-on", "schema-field-undescribed"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toBe("fail-on: schema-field-undescribed reported 2 findings\n");
    expect(stdout.text()).toMatch(/^note\tschema-field-undescribed\t/m);
    expect(stdout.text()).not.toMatch(/^error\t/m);
  });

  it("exits 0 when the code is valid but nothing reported it", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--fail-on", "repeated-scenario-prefix"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).not.toContain("fail-on:");
  });

  it("refuses a code tend never reports, pointing at nuka tend --codes", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--fail-on", "pattern-unbond"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe('refused\tfail-on-unknown-code\t-\t--fail-on: "pattern-unbond" is not a code nuka tend reports\n  do: nuka tend --codes\n');
  });

  it("refuses the codes removed with rationale and with the check duplicates, naming what to do instead", async () => {
    const expected: Record<string, string> = {
      "step-rationale-missing":
        'refused\tfail-on-unknown-code\t-\t--fail-on: "step-rationale-missing" was removed with defineStep\'s `rationale` option. ' +
        "Delete the `rationale:` lines from your step files; `nuka check` names each one as step-option-ignored (docs/upgrading.md).\n",
      "additional-feature-dir-missing":
        'refused\tfail-on-unknown-code\t-\t--fail-on: "additional-feature-dir-missing" is reported only by `nuka check` now, as an error, ' +
        "so a failing `nuka check` is the gate (docs/upgrading.md).\n",
      "import-failures-unseen":
        'refused\tfail-on-unknown-code\t-\t--fail-on: "import-failures-unseen" is reported only by `nuka check` now, as `step-file-import-failed`, ' +
        "so a failing `nuka check` is the gate (docs/upgrading.md).\n",
    };
    for (const [code, message] of Object.entries(expected)) {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      expect(await runCli(["tend", "--fail-on", code], { rootDir, stdout, stderr })).toBe(2);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe(`${message}  do: nuka tend\n`);
    }
  });

  it("refuses a removed sign-off code by name and names what replaced it", async () => {
    for (const code of [...REMOVED_TEND_CODES.keys()].filter((key) => key.includes("sign"))) {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["tend", "--fail-on", code], { rootDir, stdout, stderr });
      expect(exitCode).toBe(2);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe(
        `refused\tfail-on-unknown-code\t-\t--fail-on: "${code}" was removed with \`nuka accept\`. A person now reads the run summary \`nuka run\` writes, ` +
          "on the pull request, and approving the pull request is the sign-off (docs/upgrading.md).\n" +
          "  do: nuka tend\n",
      );
    }
  });

  it("takes a comma-separated list and a repeated flag alike", async () => {
    const commaErr = createCaptureSink();
    expect(
      await runCli(["tend", "--fail-on", "repeated-scenario-prefix,schema-field-undescribed"], { rootDir, stdout: createCaptureSink(), stderr: commaErr }),
    ).toBe(1);
    expect(commaErr.text()).toBe("fail-on: schema-field-undescribed reported 2 findings\n");

    const repeatedErr = createCaptureSink();
    expect(
      await runCli(["tend", "--fail-on", "repeated-scenario-prefix", "--fail-on", "schema-field-undescribed"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: repeatedErr,
      }),
    ).toBe(1);
    expect(repeatedErr.text()).toBe("fail-on: schema-field-undescribed reported 2 findings\n");
  });

  it("keeps --json output parseable while the exit code turns red", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json", "--fail-on", "schema-field-undescribed"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(1);
    const report = bySeverity(stdout.text());
    expect(report.notes.map((issue: { code: string; step: string }) => [issue.code, issue.step])).toEqual([
      ["schema-field-undescribed", "visitor-arrives"],
      ["schema-field-undescribed", "visitor-greeted"],
    ]);
  });
});

describe("the do line of a removed --fail-on code", () => {
  it("keeps the other flags and codes of the command", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["tend", "--json", "--fail-on", "pattern-unbound,step-rationale-missing", "--fail-on", "fixture-unused"],
      { rootDir: repoRoot, stdout, stderr },
    );
    expect(exitCode).toBe(2);
    expect((JSON.parse(stdout.text()) as { findings: { severity: string; do: string }[] }).findings.find((f) => f.severity === "refused")!.do).toBe(
      "nuka tend --json --fail-on pattern-unbound,fixture-unused",
    );
  });

  it("names every kept code once in order and no removed code", () =>
    hegel.test((tc) => {
      const codes = tc.draw(gs.arrays(gs.sampledFrom([...TEND_CODES, ...REMOVED_TEND_CODES.keys()]), { maxSize: 6 }));
      const removed = new Set(codes.filter((code) => REMOVED_TEND_CODES.has(code)));
      const kept = codes.filter((code) => !removed.has(code));
      expect(tendCommandWithout(removed, { json: false, failOn: codes })).toBe(
        kept.length === 0 ? "nuka tend" : `nuka tend --fail-on ${kept.join(",")}`,
      );
    }));
});
