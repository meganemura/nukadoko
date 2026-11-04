import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { exampleLine } from "../src/binding/example-line.js";
import { buildExpression } from "../src/binding/expression.js";
import { createParameterTypeRegistry } from "../src/binding/registry.js";
import { checkBindings } from "../src/check/binding-check.js";
import { createStepTextMatcher } from "../src/check/feature-check.js";
import { checkStateOrder, stateShapeIssues, type StateIssue } from "../src/check/state-order.js";
import type { HookRegistration, HookType } from "../src/compat/hooks.js";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";
import { attachStepLines, parseFeatureSource } from "../src/feature/load-features.js";
import { defineStep, type RunStep } from "../src/step/define-step.js";
import type { StateRef } from "../src/step/states.js";

// The walk behind state-missing (docs/spec.md "States"), held to a
// reference that knows nothing of facts or folding: for each state and each
// holder, the set of values the state can have before each line, over every
// way each effect nukadoko cannot read could go. A line is reported exactly
// when that set is {not held}.

const STATES = ["a", "b"] as const;
type StateName = (typeof STATES)[number];
const HOLDERS = ["aki", "ben"] as const;
/** Stands for every holder no line names. */
const NOBODY_NAMED = "zed";

interface Entry {
  readonly state: StateName;
  readonly keyed: boolean;
}

interface StepModel {
  /** Whether the holder a line captures reaches the step unchanged. */
  readonly stated: boolean;
  readonly requires: readonly Entry[];
  readonly gives: readonly Entry[];
  readonly ends: readonly Entry[];
  /** Earlier steps' indexes. */
  readonly parts: readonly number[];
}

type LineModel =
  | { readonly kind: "step"; readonly step: number; readonly holder: string }
  | { readonly kind: "compat" }
  | { readonly kind: "unmatched" };

interface HookModel {
  readonly type: HookType;
  readonly tags: string | undefined;
}

interface Model {
  readonly keyed: Readonly<Record<StateName, boolean>>;
  readonly steps: readonly StepModel[];
  /** By state: the index of a step that gives it to the holder its line names, and nothing else. */
  readonly givers: Readonly<Partial<Record<StateName, number>>>;
  readonly lines: readonly LineModel[];
  readonly background: number;
  readonly tagged: boolean;
  readonly hooks: readonly HookModel[];
  readonly customWorld: boolean;
}

const COMPAT_TEXT = "the legacy line runs";
const UNMATCHED_TEXT = "nothing matches this line";

function drawModel(tc: hegel.TestCase): Model {
  const keyed = { a: tc.draw(gs.booleans()), b: tc.draw(gs.booleans()) };
  // Now and then an entry is written the other way, so the state is mismatched.
  const entry = (state: StateName): Entry => ({ state, keyed: tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0 ? !keyed[state] : keyed[state] });
  const stepCount = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
  const steps: StepModel[] = [];
  for (let index = 0; index < stepCount; index++) {
    const requires: Entry[] = [];
    const gives: Entry[] = [];
    const ends: Entry[] = [];
    for (const state of STATES) {
      if (tc.draw(gs.booleans())) requires.push(entry(state));
      const op = tc.draw(gs.sampledFrom(["none", "none", "give", "end"] as const));
      if (op === "give") gives.push(entry(state));
      if (op === "end") ends.push(entry(state));
    }
    const parts = Array.from({ length: index }, (_, earlier) => earlier).filter(() => tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0);
    steps.push({ stated: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0, requires, gives, ends, parts });
  }
  const givers: Partial<Record<StateName, number>> = {};
  for (const state of STATES) {
    if (!tc.draw(gs.booleans())) continue;
    givers[state] = steps.length;
    steps.push({ stated: true, requires: [], gives: [{ state, keyed: keyed[state] }], ends: [], parts: [] });
  }
  const line = gs.composite((inner): LineModel => {
    const kind = inner.draw(gs.integers({ minValue: 0, maxValue: 9 }));
    if (kind === 0) return { kind: "compat" };
    if (kind === 1) return { kind: "unmatched" };
    return { kind: "step", step: inner.draw(gs.integers({ minValue: 0, maxValue: steps.length - 1 })), holder: inner.draw(gs.sampledFrom(HOLDERS)) };
  });
  const lines = tc.draw(gs.arrays(line, { minSize: 1, maxSize: 7 }));
  const hook = gs.composite(
    (inner): HookModel => ({
      type: inner.draw(gs.sampledFrom(["before", "after", "after_step"] as const)),
      tags: inner.draw(gs.sampledFrom([undefined, "@hooked", "@elsewhere"])),
    }),
  );
  const hooks = tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) === 0 ? tc.draw(gs.arrays(hook, { maxSize: 2 })) : [];
  return {
    keyed,
    steps,
    givers,
    lines,
    background: tc.draw(gs.integers({ minValue: 0, maxValue: lines.length - 1 })),
    tagged: tc.draw(gs.booleans()),
    hooks,
    customWorld: tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0,
  };
}

function vocabularyOf(model: Model): Vocabulary {
  const ref = (entry: Entry): StateRef<"person"> => (entry.keyed ? [entry.state, "person"] : entry.state);
  const built: RunStep[] = [];
  const vocabulary = new Map<string, VocabularyEntry>();
  model.steps.forEach((step, index) => {
    const defined = defineStep({
      pattern: `do s${index} for {person:word}`,
      description: `s${index}`,
      // toLowerCase rewrites what the line captured, so only the run knows the holder.
      args: z.object({ person: step.stated ? z.string() : z.string().toLowerCase() }),
      requires: step.requires.map(ref),
      gives: step.gives.map(ref),
      ends: step.ends.map(ref),
      parts: step.parts.map((part) => built[part]!),
      run() {},
    });
    built.push(defined);
    vocabulary.set(`s${index}`, { kind: "typed", name: `s${index}`, filePath: `features/steps/s${index}.ts`, step: defined });
  });
  vocabulary.set(`compat: ${COMPAT_TEXT}`, {
    kind: "compat",
    name: `compat: ${COMPAT_TEXT}`,
    filePath: "features/steps/legacy.ts",
    compat: { keyword: "Given", pattern: COMPAT_TEXT, patternSource: COMPAT_TEXT, fn: () => undefined, registrationOrder: 0 },
  });
  return vocabulary;
}

function textOf(line: LineModel): string {
  if (line.kind === "compat") return COMPAT_TEXT;
  if (line.kind === "unmatched") return UNMATCHED_TEXT;
  return `do s${line.step} for ${line.holder}`;
}

function walk(model: Model, vocabulary: Vocabulary, lines: readonly LineModel[] = model.lines, background = model.background): readonly StateIssue[] {
  const texts = lines.map(textOf);
  const source = [
    "Feature: states",
    ...(background > 0 ? ["  Background:", ...texts.slice(0, background).map((text) => `    Given ${text}`)] : []),
    ...(model.tagged ? ["  @hooked"] : []),
    "  Scenario: one",
    ...texts.slice(background).map((text) => `    Given ${text}`),
    "",
  ].join("\n");
  const { gherkinDocument, pickles } = parseFeatureSource(source, "features/states.feature");
  const pickle = attachStepLines(pickles, gherkinDocument)[0]!;
  const hooks: HookRegistration[] = model.hooks.map((hook, order) => ({ type: hook.type, tags: hook.tags, fn: () => undefined, registrationOrder: order }));
  const match = createStepTextMatcher(checkBindings(vocabulary).patterns);
  return checkStateOrder(pickle, vocabulary, match, { hooks, customWorld: model.customWorld }, (stepIndex) => pickle.steps[stepIndex]?.line);
}

/** One entry per requiring line the walk reports, folded lines included:
 * `line|state|holder`, with "" for an unkeyed state and "*" for a holder
 * only the run knows. */
function reported(issues: readonly StateIssue[]): string[] {
  return issues
    .flatMap((issue) => [issue.stepIndex, ...issue.alsoRequiredAt].map((at) => `${at}|${issue.state}|${issue.holder ?? (issue.key === undefined ? "" : "*")}`))
    .sort();
}

type Reachable = ReadonlySet<boolean>;
const NOT_HELD: Reachable = new Set([false]);
const HELD: Reachable = new Set([true]);
const EITHER: Reachable = new Set([true, false]);

function reference(model: Model, lines: readonly LineModel[] = model.lines): string[] {
  const shapes = (state: StateName): Set<boolean> =>
    new Set(model.steps.flatMap((step) => [...step.requires, ...step.gives, ...step.ends].filter((use) => use.state === state).map((use) => use.keyed)));
  const throughParts = (index: number, state: StateName): boolean =>
    model.steps[index]!.parts.some((part) => [...model.steps[part]!.gives, ...model.steps[part]!.ends].some((use) => use.state === state) || throughParts(part, state));
  const applies = (hook: HookModel): boolean => hook.tags === undefined || (hook.tags === "@hooked" && model.tagged);
  const unknownStart = model.customWorld || model.hooks.some((hook) => hook.type === "before" && applies(hook));
  const afterEachLine = model.hooks.some((hook) => hook.type === "after_step" && applies(hook));
  const certainlyNot = (reach: Reachable): boolean => reach.size === 1 && reach.has(false);

  const found: string[] = [];
  for (const state of STATES) {
    const shape = shapes(state);
    if (shape.size !== 1) continue;
    const keyed = shape.has(true);
    const holders = keyed ? [...HOLDERS, NOBODY_NAMED] : [""];
    const reach = new Map<string, Reachable>(holders.map((holder) => [holder, unknownStart ? EITHER : NOT_HELD]));
    lines.forEach((line, at) => {
      if (line.kind !== "step") {
        for (const holder of holders) reach.set(holder, EITHER);
      } else {
        const step = model.steps[line.step]!;
        const target = keyed ? line.holder : "";
        const stated = !keyed || step.stated;
        if (step.requires.some((use) => use.state === state)) {
          if (stated && certainlyNot(reach.get(target)!)) found.push(`${at}|${state}|${target}`);
          if (!stated && holders.every((holder) => certainlyNot(reach.get(holder)!))) found.push(`${at}|${state}|*`);
        }
        const gives = step.gives.some((use) => use.state === state);
        const ends = step.ends.some((use) => use.state === state);
        for (const holder of holders) {
          const before = reach.get(holder)!;
          const outcome = gives ? true : false;
          if (gives || ends) {
            if (stated) reach.set(holder, holder === target ? (outcome ? HELD : NOT_HELD) : before);
            else reach.set(holder, new Set([...before, outcome]));
          } else if (throughParts(line.step, state)) {
            reach.set(holder, EITHER);
          }
        }
      }
      if (afterEachLine) for (const holder of holders) reach.set(holder, EITHER);
    });
  }
  return found.sort();
}

describe("checkStateOrder", () => {
  it("reports exactly the requiring lines every resolution of the unknown effects reaches without the state", () =>
    hegel.test(
      (tc) => {
        const model = drawModel(tc);
        const vocabulary = vocabularyOf(model);
        const issues = walk(model, vocabulary);
        expect(reported(issues)).toEqual(reference(model));
        expect(walk(model, vocabulary)).toEqual(issues);
      },
      { testCases: 400 },
    ));

  it("reports nothing on a vocabulary that names no state", () =>
    hegel.test((tc) => {
      const model = drawModel(tc);
      const bare = { ...model, steps: model.steps.map((step) => ({ ...step, requires: [], gives: [], ends: [] })) };
      expect(walk(bare, vocabularyOf(bare))).toEqual([]);
    }));

  it("judges a line by the lines before it only", () =>
    hegel.test((tc) => {
      const model = drawModel(tc);
      const vocabulary = vocabularyOf(model);
      const length = tc.draw(gs.integers({ minValue: 1, maxValue: model.lines.length }));
      const prefix = walk(model, vocabulary, model.lines.slice(0, length), Math.min(model.background, length - 1));
      const whole = reported(walk(model, vocabulary)).filter((entry) => Number(entry.split("|")[0]) < length);
      expect(reported(prefix)).toEqual(whole);
    }));

  it("settles a finding and every line folded into it when a giving line goes right before it, and reports nothing new", () =>
    hegel.test(
      (tc) => {
        const model = drawModel(tc);
        const vocabulary = vocabularyOf(model);
        const issues = walk(model, vocabulary).filter((issue) => model.givers[issue.state as StateName] !== undefined);
        if (issues.length === 0) return;
        // A finding that folds later lines is the case worth drawing most.
        const folding = issues.filter((candidate) => candidate.alsoRequiredAt.length > 0);
        const issue = tc.draw(gs.sampledFrom(folding.length > 0 ? folding : issues));
        const giving: LineModel = { kind: "step", step: model.givers[issue.state as StateName]!, holder: issue.holder ?? "aki" };
        const at = issue.stepIndex;
        const lines = [...model.lines.slice(0, at), giving, ...model.lines.slice(at)];
        const background = at < model.background ? model.background + 1 : model.background;
        const shifted = (entry: string): string => {
          const [line, ...rest] = entry.split("|");
          return [Number(line) < at ? Number(line) : Number(line) + 1, ...rest].join("|");
        };
        const settled = new Set(reported([issue]).map(shifted));
        const before = reported(walk(model, vocabulary)).map(shifted);
        const after = reported(walk(model, vocabulary, lines, background));
        expect(after.filter((entry) => settled.has(entry))).toEqual([]);
        expect(after.every((entry) => before.includes(entry))).toBe(true);
      },
      { testCases: 600 },
    ));
});

describe("stateShapeIssues", () => {
  it("names the state a step keys and another writes bare, with both lists of steps", () => {
    const signIn = defineStep({ description: "d", args: z.object({ person: z.string() }), gives: [["signed-in", "person"]], run() {} });
    const settings = defineStep({ description: "d", args: z.object({}), requires: ["signed-in"], run() {} });
    const vocabulary: Vocabulary = new Map([
      ["sign-in", { kind: "typed", name: "sign-in", filePath: "features/steps/sign-in.ts", step: signIn }],
      ["open-settings", { kind: "typed", name: "open-settings", filePath: "features/steps/open-settings.ts", step: settings }],
    ]);
    expect(stateShapeIssues(vocabulary)).toEqual([
      {
        state: "signed-in",
        keyed: ["sign-in"],
        unkeyed: ["open-settings"],
        message: 'State "signed-in" has a holder key in step "sign-in" and none in step "open-settings", so no line that requires it is judged',
        fix: 'Write "signed-in" the same way in every step: ["signed-in", "<key>"] in each requires, gives, and ends entry, or the bare name in all of them.',
      },
    ]);
  });
});

describe("exampleLine", () => {
  type Token =
    | { readonly kind: "literal"; readonly text: string }
    | { readonly kind: "capture"; readonly type: "word" | "string" | "int" }
    | { readonly kind: "suffix"; readonly text: string }
    | { readonly kind: "alone" }
    | { readonly kind: "alternation"; readonly first: string }
    | { readonly kind: "escape" };

  const token = gs.composite((tc): Token => {
    const kind = tc.draw(gs.sampledFrom(["literal", "capture", "capture", "suffix", "alone", "alternation", "escape"] as const));
    const word = (): string => tc.draw(gs.sampledFrom(["sign", "the", "page", "in"]));
    switch (kind) {
      case "literal":
        return { kind, text: word() };
      case "capture":
        return { kind, type: tc.draw(gs.sampledFrom(["word", "string", "int"] as const)) };
      case "suffix":
        return { kind, text: word() };
      case "alternation":
        return { kind, first: word() };
      default:
        return { kind };
    }
  });

  const values = {
    word: gs.sampledFrom(["aki", "o'neil", "x-1", "Zoë"]),
    string: gs.sampledFrom(["", "Aki Tanaka", 'say "hi"', "it's", "a/b (c) {d}"]),
    int: gs.sampledFrom(["0", "42", "-7"]),
  };

  it("renders a line its own pattern matches, and the match reads back each value", () =>
    hegel.test((tc) => {
      const tokens = tc.draw(gs.arrays(token, { minSize: 1, maxSize: 6 }));
      const filled = new Map<string, string>();
      const pattern = tokens
        .map((part, index) => {
          switch (part.kind) {
            case "literal":
              return part.text;
            case "capture":
              filled.set(`k${index}`, tc.draw(values[part.type]));
              return `{k${index}:${part.type}}`;
            case "suffix":
              return `${part.text}(s)`;
            case "alone":
              return "(really)";
            case "alternation":
              return `${part.first}/log(s)/out`;
            case "escape":
              return "\\(x\\) a\\/b \\{y\\}";
          }
        })
        .join(" ");
      const bound = buildExpression(pattern, createParameterTypeRegistry([]));
      const line = exampleLine(pattern, filled);
      const args = bound.expression.match(line);
      expect(args, `${pattern} -> ${line}`).not.toBeNull();
      expect(bound.captures.map((capture, index) => String(args![index]!.getValue(null)))).toEqual(bound.captures.map((capture) => filled.get(capture.key)));
      expect(line).not.toContain("  ");
    }));

  it("writes <key> for a capture it has no value for, and for a word that has a space", () => {
    expect(exampleLine("{person:word} signs in as {role:string}", new Map([["person", "aki"]]))).toBe('aki signs in as "<role>"');
    expect(exampleLine("{person:word} signs in", new Map([["person", "Aki Tanaka"]]))).toBe("<person> signs in");
    expect(exampleLine("{person:string} signs in", new Map([["person", "Aki Tanaka"]]))).toBe('"Aki Tanaka" signs in');
  });

  it("keeps a token it cannot read as written", () => {
    expect(exampleLine("{person} signs in", new Map([["person", "aki"]]))).toBe("{person} signs in");
  });
});
