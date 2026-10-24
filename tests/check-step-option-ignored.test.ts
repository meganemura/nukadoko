import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/run-cli.js";
import { defineStep, ignoredStepOptions } from "../src/step/define-step.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// A step file in a project that never runs tsc over features/ gets no
// excess-property error, so `nuka check` is the one place a leftover
// `rationale:` or a misspelled option can be named.

const CONFIG = 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';

function stepSource(pattern: string, extra: string): string {
  return [
    'import { defineStep, z } from "nukadoko";',
    "export default defineStep({",
    `  pattern: ${JSON.stringify(pattern)},`,
    '  description: "A step.",',
    extra,
    "  args: z.object({}),",
    "  mutates: false,",
    "  run() {},",
    "});",
    "",
  ].join("\n");
}

// The Then line binds a claim step, which declares no option to leave over.
const CLEAN_CLAIM_STEP = [
  'import { defineStep, z } from "nukadoko";',
  "export default defineStep({",
  '  pattern: "the clean step",',
  '  description: "A step.",',
  "  args: z.object({}),",
  '  observe: () => ({ state: "clean" }),',
  '  claims: [{ actual: "state", compare: "equal", expected: { literal: "clean" } }],',
  "});",
  "",
].join("\n");

const FEATURE = [
  "Feature: options",
  "",
  "  Scenario: three steps",
  "    Given the old step",
  "    When the misspelled step",
  "    Then the clean step",
  "",
].join("\n");

describe("nuka check: step-option-ignored", () => {
  let rootDir: string;

  beforeEach(async () => {
    await ensureNukadokoShim();
    rootDir = await createEmptyTempDir();
    const steps = path.join(rootDir, "features", "steps");
    await mkdir(steps, { recursive: true });
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), CONFIG);
    await writeFile(
      path.join(steps, "old.ts"),
      stepSource("the old step", '  rationale: "the fixture directory must be mode 0700",'),
    );
    await writeFile(path.join(steps, "misspelled.ts"), stepSource("the misspelled step", "  timeOut: 5000,"));
    await writeFile(path.join(steps, "clean.ts"), CLEAN_CLAIM_STEP);
    await writeFile(path.join(rootDir, "features", "options.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names the step file of a leftover rationale and of an unknown key, and exits 0", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
    const report = bySeverity(stdout.text()) as { errors: unknown[]; warnings: unknown[] };

    expect(exitCode).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      {
        code: "step-option-ignored",
        message: 'Step "misspelled" passes timeOut, which is not a defineStep option, so it has no effect',
        file: "features/steps/misspelled.ts",
        step: "misspelled",
        fix: "Delete timeOut from the defineStep call in features/steps/misspelled.ts, or rename it to an option defineStep reads: pattern, patterns, description, args, returns, mutates, from, timeout, parts, run, claims, observe, poll.",
      },
      {
        code: "step-option-ignored",
        message: 'Step "old" passes rationale, which defineStep no longer reads, so its text is shown nowhere',
        file: "features/steps/old.ts",
        step: "old",
        fix: "Move the rationale text into a comment above defineStep in features/steps/old.ts, then delete the rationale: line.",
      },
    ]);
  });

  it("prints the warning with its file in the text report", async () => {
    const stdout = createCaptureSink();
    await runCli(["check"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(stdout.text()).toContain(
      'warning\tstep-option-ignored\tfeatures/steps/old.ts\tStep "old" passes rationale, which defineStep no longer reads, so its text is shown nowhere\n' +
        "  fix: Move the rationale text into a comment above defineStep in features/steps/old.ts, then delete the rationale: line.\n",
    );
  });
});

const OPTIONS = ["pattern", "patterns", "description", "args", "returns", "mutates", "from", "timeout", "parts", "run"];

describe("defineStep records the keys it does not read", () => {
  const base = { description: "d", args: z.object({}), run() {} };

  it("records exactly the keys outside its options, in the order written", () =>
    hegel.test((tc) => {
      // The alphabet spells options too ("pattern", "parts"), which must
      // never be reported.
      const drawn = tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 8, alphabet: "aeinoprst" }), { maxSize: 4 }));
      const extra = [...new Set(drawn)].filter((key) => !OPTIONS.includes(key));
      const definition: Record<string, unknown> = { ...base, pattern: "a step" };
      for (const key of extra) {
        definition[key] = 1;
      }
      expect(ignoredStepOptions(defineStep(definition as typeof base))).toEqual(extra);
    }));

  it("records nothing for a definition that uses every option", () => {
    const upstream = defineStep({
      description: "d",
      args: z.object({}),
      returns: z.object({ id: z.string() }),
      run() {
        return { id: "a" };
      },
    });
    const step = defineStep({
      pattern: "a {id:string}",
      patterns: ["b {id:string}"],
      description: "d",
      args: z.object({ id: z.string() }),
      returns: z.object({}),
      mutates: false,
      from: { id: [upstream, "id"] },
      timeout: 1000,
      parts: [upstream],
      run() {
        return {};
      },
    });
    expect(ignoredStepOptions(step)).toEqual([]);
    expect(ignoredStepOptions(defineStep({ ...base, rationale: "why" } as typeof base))).toEqual(["rationale"]);
  });
});
