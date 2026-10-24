import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the three findings about condition tags, against
// tests/fixtures/condition-check-project: a tag that does not read, a tag
// that names a condition no environment declares, and a scenario no
// selected environment meets. `nuka check` reads the environments a run
// with no --env selects; `nuka run --env` reads the ones it names, so a
// scenario only a conditioned environment meets is unmet in a run of the
// deployment target alone, and `nuka check --env` reads them the same
// way. `@held` is a tag nuka check accepts.

interface Finding {
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
}

const project = fixture("condition-check-project");

async function cli(argv: readonly string[]): Promise<{ exitCode: number; findings: readonly Finding[] }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli([...argv, "--json"], { rootDir: project, stdout, stderr: createCaptureSink() });
  const document = JSON.parse(stdout.text()) as { findings: readonly (Finding & { severity: string })[] };
  return { exitCode, findings: document.findings.filter((finding) => finding.code.startsWith("condition-")) };
}

const MALFORMED = {
  code: "condition-tag-malformed",
  file: "features/tags.feature",
  line: 11,
  message: "@with: does not read as @with:<condition>, @with:<condition>=<value>, or @without:<condition>, so it names no condition",
};
const UNKNOWN = {
  code: "condition-unknown",
  file: "features/tags.feature",
  line: 15,
  message:
    '@with:colour names the condition "colour", and no environment in nukadoko.program.ts declares it under conditions. ' +
    "If colour was removed and its on side kept, remove the tag, so the scenario holds everywhere; if its off side was kept, delete the scenario.",
};

describe("nuka check: condition tags", () => {
  it("reports a malformed tag, an unknown condition, and the scenarios no selected environment meets", async () => {
    const { exitCode, findings } = await cli(["check"]);
    expect(exitCode).toBe(1);
    expect(findings.map(({ code, file, line, message }) => ({ code, file, line, message }))).toEqual([
      MALFORMED,
      UNKNOWN,
      {
        code: "condition-unmet",
        file: "features/tags.feature",
        line: 20,
        message:
          'Scenario "a value no environment has" needs @with:banner=on, and no selected environment meets it: flag-off (banner: false); flag-on (banner: true). ' +
          "Its cells would all be controls, so nothing would show that it holds",
      },
      {
        code: "condition-unmet",
        file: "features/tags.feature",
        line: 24,
        message:
          'Scenario "two tags no environment meets at once" needs @with:banner @without:banner, and no selected environment meets all of them: flag-off (banner: false); flag-on (banner: true). ' +
          "Its cells would all be controls, so nothing would show that it holds",
      },
    ]);
  });

  it("reads the environments nuka run --env names, so a deployment target alone meets no @with: scenario", async () => {
    const { exitCode, findings } = await cli(["run", "--env", "staging"]);
    expect(exitCode).toBe(2);
    expect(findings.filter((finding) => finding.code === "condition-unmet").map((finding) => [finding.line, finding.message])).toEqual([
      [4, 'Scenario "the banner is on" needs @with:banner, and no selected environment meets it: staging (no conditions). Its cells would all be controls, so nothing would show that it holds'],
      [20, 'Scenario "a value no environment has" needs @with:banner=on, and no selected environment meets it: staging (no conditions). Its cells would all be controls, so nothing would show that it holds'],
      [
        24,
        'Scenario "two tags no environment meets at once" needs @with:banner @without:banner, and no selected environment meets all of them: staging (no conditions). Its cells would all be controls, so nothing would show that it holds',
      ],
    ]);
  });

  it("reads the environments nuka check --env names the way nuka run --env does, and names that check in the refusal's do", async () => {
    const { findings } = await cli(["check", "--env", "staging", "--env", "staging"]);
    expect(findings.filter((finding) => finding.code === "condition-unmet").map((finding) => finding.line)).toEqual([4, 20, 24]);
    const stdout = createCaptureSink();
    await runCli(["run", "features/tags.feature", "--env", "staging", "--json"], { rootDir: project, stdout, stderr: createCaptureSink() });
    const refusal = (JSON.parse(stdout.text()) as { findings: { code: string; do?: string }[] }).findings.find((finding) => finding.code === "check-errors");
    expect(refusal?.do).toBe("nuka check features/tags.feature --env staging");
  });

  it("refuses an --env name the program file does not define", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--env", "stagin", "--json"], { rootDir: project, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(2);
    const finding = (JSON.parse(stdout.text()) as { findings: { code: string; message: string }[] }).findings[0]!;
    expect(finding.code).toBe("unknown-environment");
  });

  it("narrows condition-unmet to the scenarios a line target selects, and keeps the tags its file writes", async () => {
    const { findings } = await cli(["run", "features/tags.feature:4", "--env", "staging"]);
    expect(findings.map((finding) => [finding.code, finding.line])).toEqual([
      ["condition-tag-malformed", 11],
      ["condition-unknown", 15],
      ["condition-unmet", 4],
    ]);
  });

  it("refuses a program file whose condition a tag could not name", async () => {
    const rootDir = await copyFixtureToTempDir("condition-check-project");
    try {
      await writeFile(
        path.join(rootDir, "nukadoko.program.ts"),
        'import { defineProgram } from "./nukadoko-shim.js";\nexport default defineProgram({ environments: { "flag-off": { conditions: { "bad name": false, locale: "en US" } } } });\n',
      );
      const stdout = createCaptureSink();
      const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
      expect(exitCode).toBe(2);
      const finding = (JSON.parse(stdout.text()) as { findings: { code: string; message: string }[] }).findings[0]!;
      expect(finding.code).toBe("config-invalid");
      expect(finding.message).toContain(
        'environments.flag-off.conditions.locale: must be true, false, or a value with no whitespace, as @with:<name>=<value> names it; ' +
          'environments.flag-off.conditions.bad name: must be a condition name of letters, digits, "_", ".", or "-", as @with:<name> names it',
      );
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
