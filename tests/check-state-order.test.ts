import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { bySeverity } from "./helpers/envelope.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// state-missing and state-shape-mismatch (docs/spec.md "States") as nuka
// check prints them and as nuka run --no-check refuses them, on
// tests/fixtures/state-order-project: one keyed state, "signed-in", that
// sign-in gives, sign-out ends, and open-settings and display-name-is
// require.

const rootDir = fixture("state-order-project");

/** The findings of a text report with the given code, each with its
 * indented lines. */
function blocks(text: string, code: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("  ")) {
      if (found.length > 0 && found.at(-1)!.split("\t")[1] === code) found[found.length - 1] += `\n${line}`;
    } else if (line.split("\t")[1] === code) {
      found.push(line);
    } else {
      found.push("");
    }
  }
  return found.filter((block) => block.split("\t")[1] === code);
}

async function check(args: readonly string[], dir = rootDir): Promise<{ exitCode: number; text: string }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", ...args], { rootDir: dir, stdout, stderr: createCaptureSink() });
  return { exitCode, text: stdout.text() };
}

async function checkJson(args: readonly string[], dir = rootDir) {
  const { exitCode, text } = await check(["--json", ...args], dir);
  return { exitCode, report: bySeverity(text) as { errors: Array<Record<string, unknown>> } };
}

const ENDED_11 = [
  'error\tstate-missing\tfeatures/settings.feature:11\tStep "open-settings" requires "signed-in" for person "aki", and line 10 "aki signs out" (step "sign-out") ends it, with no line between them giving it again; line 12 requires it too. nuka run refuses this scenario before any of its steps runs',
  '  fix: Put a line that runs step "sign-in" ("aki signs in") between line 10 and line 11, or move line 10 below line 12. If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.',
].join("\n");

describe("nuka check: state-missing", () => {
  it("reports each scenario a line can only reach without the state, once per state and holder, and exits 1", async () => {
    const { exitCode, text } = await check(["features/settings.feature"]);
    expect(exitCode).toBe(1);
    expect(blocks(text, "state-missing")).toEqual([
      ENDED_11,
      [
        'error\tstate-missing\tfeatures/settings.feature:16\tStep "open-settings" requires "signed-in" for person "aki", and no earlier line gives it to aki: line 15 gives it to ben; line 17 requires it too. nuka run refuses this scenario before any of its steps runs',
        '  fix: Put a line that runs step "sign-in" ("aki signs in") before line 16. If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.',
      ].join("\n"),
      [
        'error\tstate-missing\tfeatures/settings.feature:20\tStep "open-settings" requires "signed-in" for person "aki", and no earlier line gives it: line 20 is the scenario\'s first line; line 21 requires it too. nuka run refuses this scenario before any of its steps runs',
        '  fix: Put a line that runs step "sign-in" ("aki signs in") before line 20. If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.',
      ].join("\n"),
    ]);
  });

  it("carries code, message, file, line, step, and fix in --json, and no do", async () => {
    const { report } = await checkJson(["features/settings.feature"]);
    const finding = report.errors.find((issue) => issue.code === "state-missing" && issue.line === 11);
    expect(finding).toEqual({
      code: "state-missing",
      message:
        'Step "open-settings" requires "signed-in" for person "aki", and line 10 "aki signs out" (step "sign-out") ends it, with no line between them giving it again; line 12 requires it too. nuka run refuses this scenario before any of its steps runs',
      file: "features/settings.feature",
      line: 11,
      step: "open-settings",
      fix: 'Put a line that runs step "sign-in" ("aki signs in") between line 10 and line 11, or move line 10 below line 12. If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.',
    });
  });

  it("says nothing of a scenario whose line requires nothing, to show what happens without the state", async () => {
    const { report } = await checkJson(["features/settings.feature"]);
    expect(report.errors.filter((issue) => Number(issue.line) >= 23)).toEqual([]);
  });

  it("stays silent where compat code could have given the state, and still reports an end after a Before hook", async () => {
    const { report } = await checkJson(["features/unknown.feature"]);
    const lines = report.errors.filter((issue) => issue.code === "state-missing").map((issue) => [issue.line, issue.message]);
    expect(lines).toEqual([
      [
        19,
        'Step "open-settings" requires "signed-in" for person "aki", and line 18 "aki signs out" (step "sign-out") ends it, with no line between them giving it again; line 20 requires it too. nuka run refuses this scenario before any of its steps runs',
      ],
    ]);
  });

  it("reports one finding per holder an outline's rows name on one line, and none for the row that holds it", async () => {
    const { report } = await checkJson(["features/outline.feature"]);
    expect(report.errors.filter((issue) => issue.code === "state-missing").map((issue) => [issue.line, issue.message])).toEqual([
      [5, expect.stringContaining('for person "aki", and no earlier line gives it to aki: line 4 gives it to ben; line 6 requires it too.')],
      [5, expect.stringContaining('for person "carol", and no earlier line gives it to carol: line 4 gives it to ben; line 6 requires it too.')],
    ]);
  });

  it("reports a Background line once, with the lines of every scenario it settles", async () => {
    const { text } = await check(["features/background.feature"]);
    expect(blocks(text, "state-missing")).toEqual([
      [
        'error\tstate-missing\tfeatures/background.feature:4\tStep "open-settings" requires "signed-in" for person "aki", and no earlier line gives it: line 4 is the scenario\'s first line; lines 7 and 10 require it too. nuka run refuses this scenario before any of its steps runs',
        '  fix: Put a line that runs step "sign-in" ("aki signs in") before line 4. If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.',
      ].join("\n"),
    ]);
  });

  it("names the move of the ending line only when the lines a Background finding folds lie in one scenario", async () => {
    const dir = await copyFixtureToTempDir("state-order-project");
    try {
      const background = [
        "Feature: A Background that ends the state",
        "",
        "  Background:",
        "    Given aki signs in",
        "    When aki signs out",
        "    And aki opens the settings page",
        "",
        "  Scenario: The display name",
        '    Then aki\'s display name is "aki"',
        "",
      ];
      const fixOf = async (lines: readonly string[]) => {
        await writeFile(path.join(dir, "features", "ended.feature"), lines.join("\n"));
        const { report } = await checkJson(["features/ended.feature"], dir);
        return report.errors.filter((issue) => issue.code === "state-missing").map((issue) => [issue.line, issue.fix]);
      };
      const rest = 'If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.';
      expect(await fixOf(background)).toEqual([
        [6, `Put a line that runs step "sign-in" ("aki signs in") between line 5 and line 6, or move line 5 below line 9. ${rest}`],
      ]);
      expect(await fixOf([...background, "  Scenario: The settings page again", "    When aki opens the settings page", ""])).toEqual([
        [6, `Put a line that runs step "sign-in" ("aki signs in") between line 5 and line 6. ${rest}`],
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("names as givers only the steps with a pattern, and with none, says no step gives the state", async () => {
    const dir = await copyFixtureToTempDir("state-order-project");
    try {
      const steps = path.join(dir, "features", "steps");
      await writeFile(
        path.join(steps, "sign-in.ts"),
        [
          'import { defineStep, z } from "../../nukadoko-shim.js";',
          "",
          "export default defineStep({",
          '  description: "Sign in with the person\'s test account",',
          "  args: z.object({ person: z.string() }),",
          '  gives: [["signed-in", "person"]],',
          "  run() {},",
          "});",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(dir, "features", "first.feature"),
        ["Feature: Settings", "", "  Scenario: The settings page first", "    When aki opens the settings page", ""].join("\n"),
      );
      const findings = async () => {
        const { report } = await checkJson(["features/first.feature"], dir);
        return report.errors.filter((issue) => issue.code === "state-missing").map((issue) => [issue.line, issue.message, issue.fix]);
      };
      expect(await findings()).toEqual([
        [
          4,
          'Step "open-settings" requires "signed-in" for person "aki", and no step gives it, so no line can. nuka run refuses this scenario before any of its steps runs',
          'Add ["signed-in", "<key>"] to the gives of the step that leaves it holding, or correct the name in the requires of step "open-settings". No step gives a state yet.',
        ],
      ]);
      await writeFile(
        path.join(steps, "sign-in-from-home.ts"),
        [
          'import { defineStep, z } from "../../nukadoko-shim.js";',
          'import signIn from "./sign-in.js";',
          "",
          "export default defineStep({",
          '  pattern: "{person:word} signs in from the home page",',
          '  description: "Sign in from the home page",',
          "  args: z.object({ person: z.string() }),",
          "  parts: [signIn],",
          '  gives: [["signed-in", "person"]],',
          "  async run({ call }, { person }) {",
          "    await call(signIn, { person });",
          "  },",
          "});",
          "",
        ].join("\n"),
      );
      expect((await findings()).map(([line, , fix]) => [line, fix])).toEqual([
        [
          4,
          'Put a line that runs step "sign-in-from-home" ("aki signs in from the home page") before line 4. If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.',
        ],
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("names an earlier step that may give the state without saying so, and the states steps give for a name no step gives", async () => {
    const { text } = await check(["features/undeclared.feature"]);
    expect(blocks(text, "state-missing")).toEqual([
      [
        'error\tstate-missing\tfeatures/undeclared.feature:5\tStep "open-settings" requires "signed-in" for person "aki", and no earlier line gives it to aki; line 6 requires it too. nuka run refuses this scenario before any of its steps runs',
        '  fix: Put a line that runs step "sign-in" ("aki signs in") before line 5. Or, if step "open-home" gives "signed-in" without saying so, add ["signed-in", "<key>"] to its gives. If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.',
      ].join("\n"),
      [
        'error\tstate-missing\tfeatures/undeclared.feature:10\tStep "open-preferences" requires "signed_in" for person "aki", and no step gives it, so no line can. nuka run refuses this scenario before any of its steps runs',
        '  fix: Add ["signed_in", "<key>"] to the gives of the step that leaves it holding, or correct the name in the requires of step "open-preferences". The states steps give: "signed-in".',
      ].join("\n"),
    ]);
  });

  it("judges a composite by what it declares, and stays silent on one whose parts give a state it does not name", async () => {
    const dir = await copyFixtureToTempDir("state-order-project");
    try {
      await writeFile(
        path.join(dir, "features", "steps", "sign-in-through-the-menu.ts"),
        [
          'import { defineStep, z } from "../../nukadoko-shim.js";',
          'import signIn from "./sign-in.js";',
          "",
          "export default defineStep({",
          '  pattern: "{person:word} signs in through the menu",',
          '  description: "Sign in through the account menu",',
          "  args: z.object({ person: z.string() }),",
          "  parts: [signIn],",
          "  async run({ call }, { person }) {",
          "    await call(signIn, { person });",
          "  },",
          "});",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(dir, "features", "steps", "sign-in-from-home.ts"),
        [
          'import { defineStep, z } from "../../nukadoko-shim.js";',
          'import signIn from "./sign-in.js";',
          "",
          "export default defineStep({",
          '  pattern: "{person:word} signs in from the home page",',
          '  description: "Sign in from the home page",',
          "  args: z.object({ person: z.string() }),",
          "  parts: [signIn],",
          '  gives: [["signed-in", "person"]],',
          "  async run({ call }, { person }) {",
          "    await call(signIn, { person });",
          "  },",
          "});",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(dir, "features", "composite.feature"),
        [
          "Feature: Composites",
          "",
          "  Scenario: A composite that says nothing of its parts",
          "    Given aki signs in through the menu",
          "    When aki opens the settings page",
          "",
          "  Scenario: A composite that declares what its parts give",
          "    Given ben signs in from the home page",
          "    When aki opens the settings page",
          "",
        ].join("\n"),
      );
      const { report } = await checkJson(["features/composite.feature"], dir);
      expect(report.errors.filter((issue) => issue.code === "state-missing").map((issue) => [issue.line, issue.message])).toEqual([
        [9, expect.stringContaining("no earlier line gives it to aki: line 8 gives it to ben.")],
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("stays silent on what a custom World may give, and still reports an end", async () => {
    const dir = await copyFixtureToTempDir("state-order-project");
    try {
      await mkdir(path.join(dir, "features", "support"), { recursive: true });
      await writeFile(
        path.join(dir, "features", "support", "world.ts"),
        [
          'import { setWorldConstructor, World } from "../../nukadoko-compat-shim.js";',
          "",
          "setWorldConstructor(class SignedInWorld extends World {});",
          "",
        ].join("\n"),
      );
      const { text } = await check(["features/settings.feature"], dir);
      expect(blocks(text, "state-missing")).toEqual([ENDED_11]);
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("nuka check: state-shape-mismatch", () => {
  it("names the state, the steps of each shape, and the file of the shape fewer steps use, and judges no line that requires it", async () => {
    const dir = await copyFixtureToTempDir("state-order-project");
    try {
      await writeFile(
        path.join(dir, "features", "steps", "admin-dashboard.ts"),
        [
          'import { defineStep, z } from "../../nukadoko-shim.js";',
          "",
          "export default defineStep({",
          '  pattern: "the admin opens the dashboard",',
          '  description: "Open the admin dashboard",',
          "  args: z.object({}),",
          "  mutates: false,",
          '  requires: ["signed-in"],',
          "  run() {},",
          "});",
          "",
        ].join("\n"),
      );
      const { text } = await check([], dir);
      expect(blocks(text, "state-shape-mismatch")).toEqual([
        [
          'error\tstate-shape-mismatch\tfeatures/steps/admin-dashboard.ts\tState "signed-in" has a holder key in steps "display-name-is", "open-settings", "sign-in", "sign-out" and none in step "admin-dashboard", so no line that requires it is judged',
          '  fix: Write "signed-in" the same way in every step: ["signed-in", "<key>"] in each requires, gives, and ends entry, or the bare name in all of them.',
        ].join("\n"),
      ]);
      expect(blocks(text, "state-missing").filter((block) => block.split("\n")[0]!.includes('requires "signed-in"'))).toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("nuka run: the guard refuses what state-missing reports", () => {
  it("refuses by default, naming check's errors", async () => {
    const dir = await copyFixtureToTempDir("state-order-project");
    try {
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/settings.feature"], { rootDir: dir, stdout: createCaptureSink(), stderr });
      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain(ENDED_11);
      expect(stderr.text()).toContain("nuka run did not start: nuka check reports 3 errors for these scenarios");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("under --no-check, fails the requiring line with check's message before any step runs, and runs the scenarios that pass", async () => {
    const dir = await copyFixtureToTempDir("state-order-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "--records", "--no-check", "features/settings.feature"], { rootDir: dir, stdout, stderr: createCaptureSink() });
      expect(exitCode).toBe(1);
      const records = stdout
        .text()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { scenario: string; status: string; steps: { status: string; step_record_id: string | null; error?: { message: string } }[] });
      expect(records.map((record) => [record.scenario, record.status])).toEqual([
        ["A person sees their own settings", "passed"],
        ["Settings after signing out", "failed"],
        ["The wrong person signs in", "failed"],
        ["Nobody signs in", "failed"],
        ["Signed out on purpose", "passed"],
      ]);
      const refused = records[1]!;
      expect(refused.steps.map((step) => [step.status, step.step_record_id])).toEqual([
        ["skipped", null],
        ["skipped", null],
        ["failed", null],
        ["skipped", null],
      ]);
      expect(refused.steps[2]!.error!.message).toBe(
        'Step "open-settings" requires "signed-in" for person "aki", and line 10 "aki signs out" (step "sign-out") ends it, with no line between them giving it again; line 12 requires it too. nuka run refuses this scenario before any of its steps runs',
      );
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("red, then green: the line the fix names is the whole fix", () => {
  it("reports the missing sign-in, and after the line the fix names goes in, nuka check finds nothing", async () => {
    const dir = await copyFixtureToTempDir("state-order-demo-project");
    try {
      const red = await check([], dir);
      expect(red).toEqual({
        exitCode: 1,
        text: [
          'error\tstate-missing\tfeatures/settings.feature:4\tStep "open-settings" requires "signed-in" for person "aki", and no earlier line gives it: line 4 is the scenario\'s first line; line 5 requires it too. nuka run refuses this scenario before any of its steps runs',
          '  fix: Put a line that runs step "sign-in" ("aki signs in") before line 4. If the scenario means to show what happens without "signed-in", the line needs a step that does not require it.',
          "note\tpattern-unbound\tfeatures/steps/sign-in.ts\tStep \"sign-in\" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.",
          "  fix: Write a feature line that matches the pattern, or remove the pattern if only nuka do runs the step.",
          "",
        ].join("\n"),
      });
      const featurePath = path.join(dir, "features", "settings.feature");
      const lines = (await readFile(featurePath, "utf8")).split("\n");
      lines.splice(3, 0, "    Given aki signs in");
      await writeFile(featurePath, lines.join("\n"));
      expect(await check([], dir)).toEqual({ exitCode: 0, text: "ok: no issues found\n" });
    } finally {
      await removeTempDir(dir);
    }
  });
});
