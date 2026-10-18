import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeProject } from "../src/check/analyze.js";
import { runCheck } from "../src/cli/check.js";
import { runCli } from "../src/cli/run-cli.js";
import { runTend } from "../src/cli/tend.js";
import { analyzeTend } from "../src/tend/analyze.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";
import { parseFindings } from "../src/finding/finding.js";

const CONFIG = 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';

// Each entry is one step file's pattern and args; most of them are broken in
// a different way, so a generated project raises step-scoped findings of
// many codes at once.
const STEP_SHAPES = [
  { pattern: "a {item:string} is listed", args: "z.object({ item: z.string() })", mutates: false },
  { pattern: "an unnamed {int} thing", args: "z.object({})", mutates: false },
  { pattern: "an open {thing", args: "z.object({})", mutates: false },
  { pattern: "a bad {1x:int} key", args: "z.object({})", mutates: false },
  { pattern: "a {who:person} arrives", args: "z.object({ who: z.string() })", mutates: false },
  { pattern: "a bare {v:string}", args: "z.string()", mutates: false },
  { pattern: "{a:int} and {a:int}", args: "z.object({ a: z.number() })", mutates: false },
  { pattern: "a {missing:int} key", args: "z.object({})", mutates: false },
  { pattern: "the result is shown", args: "z.object({})", mutates: true },
] as const;

const FEATURE_LINES = ['Given a "milk" is listed', "Given nothing defines this", "Then the result is shown", "When 3 and 3"];

function stepSource(shape: (typeof STEP_SHAPES)[number]): string {
  return [
    'import { defineStep, z } from "nukadoko";',
    "export default defineStep({",
    `  pattern: ${JSON.stringify(shape.pattern)},`,
    '  description: "A generated step.",',
    `  args: ${shape.args},`,
    "  returns: z.object({}),",
    `  mutates: ${shape.mutates},`,
    "  run() {",
    "    return {};",
    "  },",
    "});",
    "",
  ].join("\n");
}

describe("every finding carries file and do", () => {
  let parent: string;

  beforeAll(async () => {
    await ensureNukadokoShim();
    parent = await createEmptyTempDir();
  });

  afterAll(async () => {
    await removeTempDir(parent);
  });

  it("names the defining step file and a next step for each check and tend finding", () =>
    hegel.testAsync(
      async (tc) => {
        const shapes = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: STEP_SHAPES.length - 1 }), { minSize: 1, maxSize: 4 }));
        const lines = tc.draw(gs.arrays(gs.sampledFrom(FEATURE_LINES), { minSize: 1, maxSize: 4 }));
        const rootDir = await mkdtemp(path.join(parent, "case-"));
        await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
        await writeFile(path.join(rootDir, "nukadoko.config.ts"), CONFIG);
        await writeFile(
          path.join(rootDir, "features", "generated.feature"),
          ["Feature: generated", "  Scenario: one", ...lines.map((line) => `    ${line}`), ""].join("\n"),
        );
        const names = shapes.map((shape, index) => `step-${index}-${shape}`);
        for (const [index, shape] of shapes.entries()) {
          await writeFile(path.join(rootDir, "features", "steps", `${names[index]}.ts`), stepSource(STEP_SHAPES[shape]!));
        }

        const check = await analyzeProject(rootDir);
        const tend = await analyzeTend(rootDir);
        const findings = [...check.errors, ...check.warnings, ...tend.notes];
        for (const finding of findings) {
          const hint = (finding as { fix?: string }).fix ?? (finding as { do?: string }).do ?? "";
          expect(hint.length, `${finding.code} has a fix or a do`).toBeGreaterThan(0);
          expect(finding.file, `${finding.code} has a file`).toMatch(/^(features\/|nukadoko\.config\.ts$)/);
          if (finding.step !== undefined && names.includes(finding.step)) {
            expect(
              [`features/steps/${finding.step}.ts`, "features/generated.feature"],
              `${finding.code} names the file of step ${finding.step}, or the feature line`,
            ).toContain(finding.file);
          }
        }
      },
      { testCases: 10, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);
});

describe("the do line in text output", () => {
  let rootDir: string;

  beforeAll(async () => {
    await ensureNukadokoShim();
    rootDir = await createEmptyTempDir();
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), CONFIG);
    await writeFile(path.join(rootDir, "features", "steps", "broken.ts"), stepSource(STEP_SHAPES[1]));
    await writeFile(
      path.join(rootDir, "features", "greet.feature"),
      "Feature: greet\n  Scenario: one\n    Then nothing defines this\n",
    );
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("prints a do line under each nuka check finding", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCheck({ rootDir, json: false, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe(
      [
        'error\tunnamed-capture\tfeatures/steps/broken.ts\tStep "broken" pattern "an unnamed {int} thing": Parameter "{int}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps")',
        "  fix: Name the capture after the args key that it fills, as {key:type}.",
        'error\tundefined-step\tfeatures/greet.feature:3\tNo step definition matches "nothing defines this"; patterned steps no scanned feature line binds: broken ("an unnamed {int} thing", features/steps/broken.ts)',
        "  do: nuka scaffold --feature features/greet.feature",
        "",
      ].join("\n"),
    );
  });

  it("carries file and do in nuka check --json", async () => {
    const stdout = createCaptureSink();
    await runCheck({ rootDir, json: true, stdout, stderr: createCaptureSink() });

    expect(bySeverity(stdout.text()).errors[0]).toEqual({
      code: "unnamed-capture",
      message:
        'Step "broken" pattern "an unnamed {int} thing": Parameter "{int}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps")',
      step: "broken",
      file: "features/steps/broken.ts",
      fix: "Name the capture after the args key that it fills, as {key:type}.",
    });
  });

  it("prints a do line under each nuka tend note", async () => {
    const stdout = createCaptureSink();
    await runTend({ rootDir, json: false, failOn: [], stdout, stderr: createCaptureSink() });

    expect(stdout.text().split("\n").slice(3)).toEqual([
      'note\tpattern-unbound\tfeatures/steps/broken.ts\tStep "broken" declares a pattern, but no feature line under the scanned directories binds it. It has no place in any scenario right now.',
      "  fix: Write a feature line that matches the pattern, or remove the pattern if only nuka do runs the step.",
      "",
    ]);
  });

  it("names the step file in nuka steps --json and nuka describe", async () => {
    const steps = createCaptureSink();
    await runCli(["steps", "--json"], { rootDir, stdout: steps, stderr: createCaptureSink() });
    const describe = createCaptureSink();
    await runCli(["describe", "broken"], { rootDir, stdout: describe, stderr: createCaptureSink() });

    expect(JSON.parse(steps.text()).steps[0].file).toBe("features/steps/broken.ts");
    expect(JSON.parse(describe.text()).file).toBe("features/steps/broken.ts");
  });

  it("lists each code's general fix in nuka check --codes and nuka tend --codes", async () => {
    const check = createCaptureSink();
    await runCheck({ rootDir, json: true, codes: true, stdout: check, stderr: createCaptureSink() });
    const tend = createCaptureSink();
    await runTend({ rootDir, json: false, codes: true, failOn: [], stdout: tend, stderr: createCaptureSink() });

    expect(JSON.parse(check.text()).codes.find((entry: { code: string }) => entry.code === "serial-tag-on-scenario")).toEqual({
      code: "serial-tag-on-scenario",
      message:
        "A @nukadoko:serial tag is on a Scenario/Scenario Outline line; nuka run --concurrency only reads it from the Feature line, so it has no effect there.",
      severity: "error",
      fix: "Move @nukadoko:serial to the Feature line.",
    });
    expect(parseFindings(tend.text()).find((finding) => finding.code === "from-unused")).toEqual({
      severity: "note",
      code: "from-unused",
      where: "-",
      message:
        "A step's from declaration never supplies a value, because every feature line that binds the step fills that key with a pattern capture.",
      fix: "Remove the from entry for the key, or keep it for nuka do --use.",
    });
  });
});
