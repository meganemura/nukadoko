import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { PickleStepType } from "@cucumber/messages";
import { runCli } from "../src/cli/run-cli.js";
import { checkBindings } from "../src/check/binding-check.js";
import { checkFeatures } from "../src/check/feature-check.js";
import { boundStepNames, findUnboundPatternedEntries, unboundPatternedSuffix } from "../src/check/unbound-patterned.js";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";
import type { FeatureFile } from "../src/feature/load-features.js";
import { defineStep } from "../src/step/define-step.js";
import { findUnboundPatternedSteps } from "../src/tend/pattern-unbound.js";
import { resolveStepOccurrences } from "../src/tend/step-bindings.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// `undefined-step` names the patterned steps no analyzed line binds, so a
// renamed sentence or pattern points at the step that lost its line instead
// of only at `nuka scaffold`.

interface Issue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

function stepSource(pattern: string): string {
  const keys = [...pattern.matchAll(/\{(\w+):string\}/g)].map((match) => `${match[1]}: z.string()`);
  return [
    'import { z } from "zod";',
    'import { defineStep } from "nukadoko";',
    "",
    "export default defineStep({",
    `  pattern: ${JSON.stringify(pattern)},`,
    '  description: "A probe step",',
    `  args: z.object({ ${keys.join(", ")} }),`,
    "  returns: z.object({}),",
    "  mutates: false,",
    "  async run() {",
    "    return {};",
    "  },",
    "});",
    "",
  ].join("\n");
}

async function project(steps: Record<string, string>, features: Record<string, string>): Promise<string> {
  const dir = await createEmptyTempDir();
  await mkdir(path.join(dir, "features", "steps"), { recursive: true });
  await writeFile(path.join(dir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n');
  for (const [name, pattern] of Object.entries(steps)) {
    await writeFile(path.join(dir, "features", "steps", `${name}.ts`), stepSource(pattern));
  }
  for (const [name, text] of Object.entries(features)) {
    await writeFile(path.join(dir, "features", name), text);
  }
  return dir;
}

async function json(rootDir: string, args: string[]): Promise<{ errors: Issue[]; notes: Issue[] }> {
  const stdout = createCaptureSink();
  await runCli(args, { rootDir, stdout, stderr: createCaptureSink() });
  return JSON.parse(stdout.text());
}

const created: string[] = [];
async function tracked(steps: Record<string, string>, features: Record<string, string>): Promise<string> {
  const dir = await project(steps, features);
  created.push(dir);
  return dir;
}

beforeAll(ensureNukadokoShim);
afterAll(async () => {
  for (const dir of created) {
    await removeTempDir(dir);
  }
});

const greetFeature = 'Feature: greet\n\n  Scenario: greet\n    When I run greet\n    Then the output is "Hello, Ada!"\n';

describe("nuka check: undefined-step names the patterned steps no line binds", () => {
  it("after a sentence rename, names the step with its pattern and root-relative file", async () => {
    const dir = await tracked(
      { "run-greet": "I run greet", "output-says": "the output says {text:string}" },
      { "greet.feature": greetFeature },
    );
    const report = await json(dir, ["check", "--json"]);
    expect(report.errors).toEqual([
      {
        code: "undefined-step",
        message:
          'No step definition matches "the output is "Hello, Ada!""; run `nuka scaffold --feature features/greet.feature` to add one; patterned steps no scanned feature line binds: output-says ("the output says {text:string}", features/steps/output-says.ts)',
        file: "features/greet.feature",
        line: 5,
        do: "nuka scaffold --feature features/greet.feature",
      },
    ]);
  });

  it("keeps the message byte for byte when every patterned step is bound", async () => {
    const dir = await tracked({ "run-greet": "I run greet" }, { "greet.feature": greetFeature });
    const report = await json(dir, ["check", "--json"]);
    expect(report.errors.map((issue) => issue.message)).toEqual([
      'No step definition matches "the output is "Hello, Ada!""; run `nuka scaffold --feature features/greet.feature` to add one',
    ]);
  });

  it("names three unbound steps and counts the rest", async () => {
    const dir = await tracked(
      { a: "alpha happens", b: "beta happens", c: "gamma happens", d: "delta happens", "run-greet": "I run greet" },
      { "greet.feature": greetFeature },
    );
    const report = await json(dir, ["check", "--json"]);
    const message = report.errors.find((issue) => issue.code === "undefined-step")!.message;
    expect(message.endsWith(
      '; patterned steps no scanned feature line binds: a ("alpha happens", features/steps/a.ts), b ("beta happens", features/steps/b.ts), c ("gamma happens", features/steps/c.ts), and 1 more',
    )).toBe(true);
  });

  it("with a single-file target, judges bound on every scanned file, so the message matches a whole-project check", async () => {
    const dir = await tracked(
      { "run-greet": "I run greet", "other-step": "something else happens", "orphan-step": "nobody says this" },
      {
        "greet.feature": greetFeature,
        "other.feature": "Feature: other\n\n  Scenario: other\n    Given something else happens\n",
      },
    );
    const expected = [
      'No step definition matches "the output is "Hello, Ada!""; run `nuka scaffold --feature features/greet.feature` to add one; patterned steps no scanned feature line binds: orphan-step ("nobody says this", features/steps/orphan-step.ts)',
    ];
    const whole = await json(dir, ["check", "--json"]);
    expect(whole.errors.map((issue) => issue.message)).toEqual(expected);
    const selected = await json(dir, ["check", "features/greet.feature", "--json"]);
    expect(selected.errors.map((issue) => issue.message)).toEqual(expected);
  });
});

describe("nuka tend: pattern-unbound carries the step file", () => {
  it("sets file to the root-relative step file in --json and on the text line", async () => {
    const dir = await tracked(
      { "run-greet": "I run greet", "output-says": "the output says {text:string}" },
      { "greet.feature": "Feature: greet\n\n  Scenario: greet\n    When I run greet\n" },
    );
    const report = await json(dir, ["tend", "--json"]);
    const unbound = report.notes.filter((issue) => issue.code === "pattern-unbound");
    expect(unbound).toEqual([
      {
        code: "pattern-unbound",
        message:
          'Step "output-says" declares a pattern, but no feature line under the scanned directories binds it. It has no place in any scenario right now.',
        file: "features/steps/output-says.ts",
        step: "output-says",
        do: "Write a feature line that matches the pattern, or remove the pattern if only nuka do runs the step.",
      },
    ]);

    const stdout = createCaptureSink();
    await runCli(["tend"], { rootDir: dir, stdout, stderr: createCaptureSink() });
    expect(stdout.text()).toContain("note\tpattern-unbound\tfeatures/steps/output-says.ts\tStep \"output-says\"");
  });
});

// Check builds its bound set from the lines checkFeatures resolved (or, for
// a target, from boundStepNames over the scanned files), tend from
// resolveStepOccurrences; the three walks must agree on every input, or the
// suffix and the note would name different steps on the same files.
describe("the undefined-step suffix and pattern-unbound name the same steps", () => {
  const wordings = ["alpha happens", "beta happens", "gamma {n:int} happens", "delta happens", "beta happens"] as const;
  const lineTexts = ["alpha happens", "beta happens", "gamma 3 happens", "delta happens", "nothing matches this"] as const;

  function vocabulary(picked: readonly number[]): Vocabulary {
    const map = new Map<string, VocabularyEntry>();
    picked.forEach((wordingIndex, i) => {
      const pattern = wordings[wordingIndex]!;
      const name = `step-${i}`;
      map.set(name, {
        kind: "typed",
        name,
        filePath: `/project/features/steps/${name}.ts`,
        step: defineStep({
          pattern,
          description: "d",
          args: pattern.includes("{n:int}") ? z.object({ n: z.number() }) : z.object({}),
          returns: z.object({}),
          async run() {
            return {};
          },
        }),
      });
    });
    return map;
  }

  function featureFile(texts: readonly string[]): FeatureFile {
    return {
      relativePath: "features/generated.feature",
      pickles: [
        {
          id: "p",
          uri: "features/generated.feature",
          name: "generated",
          language: "en",
          astNodeIds: [],
          tags: [],
          location: { line: 3 },
          steps: texts.map((text, i) => ({
            id: `s${i}`,
            text,
            type: PickleStepType.ACTION,
            astNodeIds: [],
            line: 4 + i,
          })),
        },
      ],
    } as unknown as FeatureFile;
  }

  it("for any vocabulary and feature lines, the suffix names exactly the steps tend reports", () =>
    hegel.test((tc) => {
      const picked = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: wordings.length - 1 }), { maxSize: 5 }));
      const texts = tc.draw(gs.arrays(gs.sampledFrom([...lineTexts]), { maxSize: 6 }));
      const vocab = vocabulary(picked);
      const { patterns } = checkBindings(vocab);
      const features = [featureFile(texts)];

      const bound = new Set(checkFeatures(features, vocab, patterns).boundSteps.map((line) => line.stepName));
      expect([...boundStepNames(features, patterns)].sort()).toEqual([...bound].sort());
      const fromCheck = findUnboundPatternedEntries(vocab, bound).map((entry) => entry.name);
      const fromTend = findUnboundPatternedSteps(vocab, resolveStepOccurrences(features, patterns), "/project").map(
        (note) => note.step,
      );
      expect(fromCheck).toEqual(fromTend);

      const suffix = unboundPatternedSuffix(findUnboundPatternedEntries(vocab, bound), "/project");
      const named = [...suffix.matchAll(/(step-\d+) \(/g)].map((match) => match[1]);
      expect(named).toEqual(fromTend.slice(0, 3));
      expect(suffix === "").toBe(fromTend.length === 0);
      expect(suffix.endsWith(`and ${fromTend.length - 3} more`)).toBe(fromTend.length > 3);
    }));
});
