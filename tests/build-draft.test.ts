import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildDraft, type DraftInput } from "../src/harvest/build-draft.js";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";
import { defineStep } from "../src/step/define-step.js";
import { buildStepBindings } from "../src/run/match-step.js";
import type { StepRecordOk } from "../src/record/types.js";

// Responsibility: unit tests for src/harvest/build-draft.ts's branches that
// harvest.test.ts's own fixture-driven cases (tests/fixtures/harvest-project)
// never reach: a step record whose step fell out of the vocabulary entirely
// (deleted, not merely repatterned), one that turned into a compat step, a
// pattern that cannot render at all, and every round-trip disagreement other
// than "undefined" (already covered there via the fixture's own
// `flexible-widget` step). Every `Vocabulary`/`StepBinding` here is built by
// hand, the same "no discovery, no tsx, no filesystem" approach
// tests/validate-from.test.ts already uses for src/step/validate-from.ts, so
// each case can force an exact vocabulary/record mismatch that a real
// project on disk would take extra files and steps to reproduce.

function makeRecord(id: string, step: string, args: unknown, overrides: Partial<StepRecordOk> = {}): StepRecordOk {
  return {
    step_record_id: id,
    step,
    kind: "do",
    args,
    environment: "default",
    session: null,
    scenario_record_id: null,
    run_id: null,
    started_at: "2026-08-01T00:00:00.000Z",
    finished_at: "2026-08-01T00:00:01.000Z",
    evidence: { dir: `.nukadoko/records/steps/${id}`, screenshots: [] },
    observed: { http_reads: 0, http_writes: 0 },
    mutates: true,
    status: "ok",
    result: {},
    ...overrides,
  };
}

function typedEntry(name: string, step: ReturnType<typeof defineStep>): VocabularyEntry {
  return { kind: "typed", name, filePath: `features/steps/${name}.ts`, step };
}

function draftFor(input: Omit<DraftInput, "bindings"> & { bindings?: DraftInput["bindings"] }) {
  return buildDraft({ bindings: input.bindings ?? [], ...input });
}

describe("buildDraft: a step record that no longer has a line to render", () => {
  it("names a step record whose step is not in the current vocabulary at all", () => {
    const vocabulary: Vocabulary = new Map();
    const record = makeRecord("r-1", "ghost-step", {});

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
    });

    expect(result.featureText).not.toContain("*");
    expect(result.featureText).toContain("not in the vocabulary this project discovers now");
    expect(result.notices.some((notice) => notice.includes("ghost-step"))).toBe(true);
  });

  it("points at the `name` option on an external record whose step is not in the vocabulary", () => {
    const vocabulary: Vocabulary = new Map();
    const record = makeRecord("r-1", "ghost-step", {}, { kind: "external" });

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
    });

    expect(result.featureText).toContain("recordStep");
  });

  it("does not add the `name` option hint for a `do`-originated record", () => {
    const vocabulary: Vocabulary = new Map();
    const record = makeRecord("r-1", "ghost-step", {}, { kind: "do" });

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
    });

    expect(result.featureText).not.toContain("recordStep");
  });

  it("names a step record whose step is now a compat step, with no pattern to render", () => {
    const compatEntry: VocabularyEntry = {
      kind: "compat",
      name: "now-compat",
      filePath: "features/steps/now-compat.ts",
      compat: {
        keyword: "Given",
        pattern: "a compat thing happens",
        patternSource: "a compat thing happens",
        fn: () => undefined,
        registrationOrder: 0,
      },
    };
    const vocabulary: Vocabulary = new Map([["now-compat", compatEntry]]);
    const record = makeRecord("r-1", "now-compat", {});

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
    });

    expect(result.featureText).not.toContain("*");
    expect(result.featureText).toContain("is a compat step now");
  });

  it("names a step whose own pattern cannot become a line at all (an unnamed capture)", () => {
    const step = defineStep({
      pattern: "a {string} thing",
      description: "d",
      args: z.object({}),
      returns: z.object({}),
      run: () => ({}),
    });
    const vocabulary: Vocabulary = new Map([["bad-pattern", typedEntry("bad-pattern", step)]]);
    const record = makeRecord("r-1", "bad-pattern", {});

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
    });

    expect(result.featureText).not.toContain("*");
    expect(result.featureText).toContain("pattern cannot become a line");
  });
});

describe("buildDraft: round-trip disagreements beyond 'undefined'", () => {
  it("names a line that round-trips ambiguously, between the two steps that share its rendered text", () => {
    const stepA = defineStep({
      pattern: "a project exists",
      description: "a",
      args: z.object({}),
      returns: z.object({}),
      run: () => ({}),
    });
    const stepB = defineStep({
      pattern: "a project exists",
      description: "b",
      args: z.object({}),
      returns: z.object({}),
      run: () => ({}),
    });
    const vocabulary: Vocabulary = new Map([
      ["project-exists-a", typedEntry("project-exists-a", stepA)],
      ["project-exists-b", typedEntry("project-exists-b", stepB)],
    ]);
    const bindings = buildStepBindings(vocabulary);
    const record = makeRecord("r-1", "project-exists-a", {});

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
      bindings,
    });

    expect(result.featureText).toContain("* a project exists");
    expect(result.featureText).toMatch(/does not read back/);
    expect(result.featureText).toMatch(/ambiguous between/);
  });

  it("names a line whose own captured value breaks the whole draft's own Gherkin parse", () => {
    // `n`'s declared type is `int`, so render-line.ts writes its value with
    // a bare `String(value)`, never JSON-escaped the way a `{string}`
    // capture would be — args is documented as unvalidated/uncoerced
    // (src/record/types.ts), so a record whose `args.n` is a string
    // containing a raw newline is a legitimate record to have on disk, not
    // a fabricated one. That newline lands inside the assembled draft
    // exactly as written, which is what breaks the parse.
    const step = defineStep({
      pattern: "a {n:int} thing",
      description: "d",
      args: z.object({ n: z.number() }),
      returns: z.object({}),
      run: () => ({}),
    });
    const vocabulary: Vocabulary = new Map([["broken-thing", typedEntry("broken-thing", step)]]);
    const bindings = buildStepBindings(vocabulary);
    const record = makeRecord("r-1", "broken-thing", { n: '0\n"""\nunterminated docstring' });

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
      bindings,
    });

    expect(result.featureText).toMatch(/this draft failed to parse as Gherkin/);
  });

  it("names a line whose own captured value parses into more steps than were rendered", () => {
    const step = defineStep({
      pattern: "a {n:int} thing",
      description: "d",
      args: z.object({ n: z.number() }),
      returns: z.object({}),
      run: () => ({}),
    });
    const vocabulary: Vocabulary = new Map([["extra-thing", typedEntry("extra-thing", step)]]);
    const bindings = buildStepBindings(vocabulary);
    const record = makeRecord("r-1", "extra-thing", { n: "0\n    * an extra thing happens" });

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
      bindings,
    });

    expect(result.featureText).toMatch(/this draft parsed into 2 step\(s\), not the 1 rendered/);
  });

  it("names a line whose captured value reads back as a different value than it wrote (type coercion)", () => {
    // `args.n` is the string `"5"` on the record, which `String()` renders
    // identically to the number `5` — but the round trip re-reads the line
    // through the real `{int}` parameter type, whose transformer returns a
    // number. `record.args` unvalidated (this file's own header, above)
    // means a record like this is exactly what a `--args` call that skipped
    // the step's own schema, or a step whose own `returns` disagreed with
    // its declared type, can leave on disk.
    const step = defineStep({
      pattern: "a {n:int} thing",
      description: "d",
      args: z.object({ n: z.number() }),
      returns: z.object({}),
      run: () => ({}),
    });
    const vocabulary: Vocabulary = new Map([["coerced-thing", typedEntry("coerced-thing", step)]]);
    const bindings = buildStepBindings(vocabulary);
    const record = makeRecord("r-1", "coerced-thing", { n: "5" });

    const result = draftFor({
      orderedIds: ["r-1"],
      recordsById: new Map([["r-1", record]]),
      vocabulary,
      bindings,
    });

    expect(result.featureText).toContain("* a 5 thing");
    expect(result.featureText).toMatch(/does not read back to the same args/);
  });
});
