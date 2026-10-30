import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import type { PathKey, StepPath } from "../src/execution-events/path.js";
import type { TraceGap } from "../src/execution-events/tally.js";
import type { RunDocument, RunEnvironment, RunPathComparison, RunScenario, RunStep, RunWorld } from "../src/record/run-result.js";
import { comparePaths } from "../src/run/path-view.js";
import { renderRunSummary } from "../src/run/run-summary.js";
import { buildTable, executionOutcome, foldCell } from "../src/run/verdict-table.js";

// Responsibility: run.json's `paths` (src/run/path-view.ts) and the run
// summary's "Changed paths" section, from literal run.json documents.
// Two environments whose conditions differ in one make a pair; what one
// side's steps did is compared with the other's step by step, a count a
// side's missing lines could still reach is open and never a change, and
// a flag's side is the pair's premise, never a change. The comparison
// reads as its mirror when the two sides trade places.

const FEATURE = "features/orders.feature";

/** A side of one criterion: the path of each step that ran, in order.
 * When fewer steps ran than the criterion has, the last one failed. */
interface Side {
  readonly paths: readonly (StepPath | undefined)[];
}

interface Criterion {
  readonly line: number;
  readonly name: string;
  readonly steps: number;
  /** By environment name. */
  readonly sides: Readonly<Record<string, Side>>;
}

const OFF: RunEnvironment = { name: "reorder-off", target_version: null, conditions: { quick_reorder: false } };
const ON: RunEnvironment = { name: "reorder-on", target_version: null, conditions: { quick_reorder: true } };

/** A world that read its events file, or one at a `url` (`null`), or
 * one whose program file names no `{events}` (`"unnamed"`). */
function world(name: string, events: null | "unnamed" | "read" = "read", tree: "head" | "base" = "head"): RunWorld {
  const read = { file: null, lines: 0, owned: 0, late: 0, unowned: 0, unreadable: 0, undefined_kinds: {} };
  return { name, tree, url: "http://127.0.0.1:4100", commands: [], timings: {}, log: null, error: null, ...(events === "unnamed" ? {} : { events: events === "read" ? read : null }) };
}

function scenarioOf(criterion: Criterion, environment: string, side: Side): RunScenario {
  const steps = Array.from({ length: criterion.steps }, (_, index): RunStep => {
    const ran = index < side.paths.length;
    const failed = ran && index === side.paths.length - 1 && side.paths.length < criterion.steps;
    const path = side.paths[index];
    return {
      line: criterion.line + 1 + index,
      text: `step ${index + 1}`,
      step: "a-step",
      status: failed ? "failed" : ran ? "passed" : "skipped",
      step_record_id: ran ? `stp-${environment}-${criterion.line}-${index}` : null,
      record: ran ? `steps/stp-${environment}-${criterion.line}-${index}` : null,
      ...(failed ? { error: { kind: "claim_broken" as const, message: "broken" } } : {}),
      ...(path === undefined ? {} : { path }),
    };
  });
  const failed = side.paths.length < criterion.steps;
  return {
    scenario_record_id: `scn-${environment}-${criterion.line}`,
    feature: FEATURE,
    line: criterion.line,
    scenario: criterion.name,
    environment,
    status: failed ? "failed" : "passed",
    started_at: "2026-10-29T12:00:00.000Z",
    finished_at: "2026-10-29T12:00:01.000Z",
    steps,
    hooks: [],
  };
}

function documentOf(criteria: readonly Criterion[], environments: readonly RunEnvironment[] = [OFF, ON], worlds: readonly RunWorld[] = environments.map((environment) => world(environment.name))): RunDocument {
  const scenarios = criteria.flatMap((criterion) => environments.flatMap((environment) => (criterion.sides[environment.name] === undefined ? [] : [scenarioOf(criterion, environment.name, criterion.sides[environment.name]!)])));
  const table = buildTable({
    criteria: criteria.map((criterion) => ({ feature: FEATURE, line: criterion.line, name: criterion.name, tags: [] })),
    environments: environments.map((environment) => ({ name: environment.name, conditions: environment.conditions })),
    outcomes: (feature, line, environment) => scenarios.filter((entry) => entry.feature === feature && entry.line === line && entry.environment === environment).map((entry) => executionOutcome(entry, () => true)),
    notRunReason: () => undefined,
    proofRuns: 2,
    leftOut: 0,
  });
  return {
    schema_version: 4,
    nukadoko: "0.24.0",
    command: "run",
    verdict: "passed",
    findings: [],
    run_id: "run-20261029-120000-abcd",
    started_at: "2026-10-29T12:00:00.000Z",
    finished_at: "2026-10-29T12:01:00.000Z",
    commit: null,
    environments,
    worlds,
    selection: "full",
    counts: { scenarios: 0, passed: 0, failed: 0, not_run: 0, controls: 0, controls_not_run: 0 },
    scenarios,
    table,
  };
}

const whole = (rest: Partial<StepPath> = {}): StepPath => ({ requests: [], entries: [], maybe: 0, open: [], ...rest });

const KEYS: readonly PathKey[] = [
  { kind: "error", class: "CacheMiss", handled: true },
  { kind: "db", table: "rooms", op: "update" },
  { kind: "db", table: "scores", op: "insert" },
  { kind: "http", method: "POST", origin: "https://mail.example.test", path: "/v1/send", status: 202 },
  { kind: "job", name: "ScoreRecalcJob", phase: "enqueue" },
  { kind: "flag", name: "quick_reorder", side: "on" },
  { kind: "flag", name: "quick_reorder", side: "off" },
];
const REQUESTS = [
  { method: "POST", route: "/reorders", status: 201 },
  { method: "POST", route: "/reorders", status: 403 },
] as const;
const GAPS: readonly TraceGap[] = [{ gap: "jobs-pending", job_ids: ["3f2a9c41"] }, { gap: "no-lines" }, { gap: "unreadable", lines: 1 }];

const stepPath: gs.Generator<StepPath> = gs
  .tuples(
    gs.arrays(gs.tuples(gs.integers({ minValue: 0, maxValue: KEYS.length - 1 }), gs.integers({ minValue: 1, maxValue: 3 })), { maxSize: 4 }),
    gs.arrays(gs.integers({ minValue: 0, maxValue: REQUESTS.length - 1 }), { maxSize: 3 }),
    gs.integers({ minValue: 0, maxValue: 2 }),
    gs.arrays(gs.integers({ minValue: 0, maxValue: GAPS.length - 1 }), { maxSize: 2 }),
  )
  .map(([entries, requests, maybe, gaps]) =>
    whole({
      entries: [...new Map(entries.map(([key, count]) => [key, { ...KEYS[key]!, count }])).values()],
      requests: requests.map((index) => REQUESTS[index]!),
      maybe,
      open: [...new Set(gaps)].sort().map((index) => GAPS[index]!),
    }),
  );

function compare(off: Side, on: Side, steps = Math.max(off.paths.length, on.paths.length)): RunPathComparison {
  const [comparison] = comparePaths(documentOf([{ line: 3, name: "a reorder goes through", steps, sides: { "reorder-off": off, "reorder-on": on } }]));
  return comparison!;
}

/** A criterion under `--base`: its change, and what each environment's
 * base world ran of it. */
interface BaseCriterion extends Criterion {
  readonly change: "unchanged" | "changed" | "new";
  readonly base: Readonly<Record<string, Side>>;
}

/** A run under `--base`, its table built as `nuka run` builds it: a base
 * cell only where a new or changed row passed at head. An unchanged row
 * the base ran is an execution for paths alone, with `for_paths`. */
function baseDocumentOf(
  criteria: readonly BaseCriterion[],
  environments: readonly RunEnvironment[] = [OFF, ON],
  worlds: readonly RunWorld[] = environments.flatMap((environment) => [world(environment.name), world(environment.name, "read", "base")]),
): RunDocument {
  const head = documentOf(criteria, environments, worlds);
  const atBase = criteria.flatMap((criterion) =>
    environments.flatMap((environment): RunScenario[] => {
      const side = criterion.base[environment.name];
      if (side === undefined) return [];
      const scenario = scenarioOf(criterion, environment.name, side);
      const { outcome, line } = foldCell([executionOutcome(scenario, () => true)]);
      const forPaths = criterion.change === "unchanged" ? { for_paths: { outcome, ...(line === undefined ? {} : { line }) } } : {};
      return [{ ...scenario, scenario_record_id: `scn-base-${environment.name}-${criterion.line}`, world: "base", row: { feature: FEATURE, line: criterion.line }, ...forPaths }];
    }),
  );
  const scenarios = [...head.scenarios, ...atBase];
  const table = buildTable({
    criteria: criteria.map((criterion) => ({ feature: FEATURE, line: criterion.line, name: criterion.name, tags: [] })),
    environments: environments.map((environment) => ({ name: environment.name, conditions: environment.conditions })),
    outcomes: (feature, line, environment, at = "head") =>
      scenarios.filter((entry) => (entry.world ?? "head") === at && entry.feature === feature && entry.line === line && entry.environment === environment).map((entry) => executionOutcome(entry, () => true)),
    notRunReason: () => undefined,
    proofRuns: 1,
    leftOut: 0,
    base: {
      ref: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      mapping: { files: [], config: false, conditions: [], default_environments: false, unseen: [] },
      mappingChanged: false,
      changeOf: (_, line) => ({ change: criteria.find((criterion) => criterion.line === line)!.change }),
      removed: [],
      oldEnvironments: [],
    },
  });
  return { ...head, scenarios, table };
}

const flag = (side: "on" | "off", name = "quick_reorder"): StepPath["entries"][number] => ({ kind: "flag", name, side, count: 1, gates: ["boolean"] });

describe("comparePaths", () => {
  it("reads as its mirror when the two sides trade places", () =>
    hegel.test((tc) => {
      const one = tc.draw(gs.arrays(stepPath, { minSize: 1, maxSize: 3 }));
      const other = tc.draw(gs.arrays(stepPath, { minSize: 1, maxSize: 3 }));
      const steps = Math.max(one.length, other.length);
      const forward = compare({ paths: one }, { paths: other }, steps).criteria[0]!;
      const backward = compare({ paths: other }, { paths: one }, steps).criteria[0]!;
      expect(backward.result).toBe(forward.result);
      const mirrored = (forward.steps ?? []).map((step) =>
        step.ran === "both"
          ? { ...step, changed: step.changed.map((d) => ({ ...d, a: d.b, b: d.a })), open: step.open.map((d) => ({ ...d, a: d.b, b: d.a })), gaps: { a: step.gaps.b, b: step.gaps.a } }
          : { ...step, ran: step.ran === "a" ? "b" : "a" },
      );
      expect(backward.steps ?? []).toEqual(mirrored);
    }));

  it("never reads a count a side's missing lines could still reach as a change, and never lists a flag's side between two environments", () =>
    hegel.test((tc) => {
      const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
      const one = tc.draw(gs.arrays(stepPath, { minSize: steps, maxSize: steps }));
      const other = tc.draw(gs.arrays(stepPath, { minSize: steps, maxSize: steps }));
      for (const step of compare({ paths: one }, { paths: other }).criteria[0]!.steps ?? []) {
        if (step.ran !== "both") continue;
        for (const difference of [...step.changed, ...step.open]) expect(difference.kind).not.toBe("flag");
        for (const { a, b } of step.changed) expect((a.at_most !== null && a.at_most < b.at_least) || (b.at_most !== null && b.at_most < a.at_least)).toBe(true);
        for (const { a, b } of step.open) {
          expect((a.at_most === null || a.at_most >= b.at_least) && (b.at_most === null || b.at_most >= a.at_least)).toBe(true);
          expect(a.at_most === a.at_least && b.at_most === b.at_least && a.at_least === b.at_least).toBe(false);
        }
      }
    }));

  it("finds a path the same as itself, so far when it is not whole, and keeps no steps when it is", () =>
    hegel.test((tc) => {
      const paths = tc.draw(gs.arrays(stepPath, { minSize: 1, maxSize: 3 }));
      const criterion = compare({ paths }, { paths }).criteria[0]!;
      expect(["same_so_far", "same"]).toContain(criterion.result);
      if (paths.every((path) => path.open.length === 0 && path.maybe === 0)) expect(criterion).not.toHaveProperty("steps");
    }));

  it("reads a criterion as the same so far only when every open count has one range on both sides, under the same gap words", () =>
    hegel.test((tc) => {
      const one = tc.draw(gs.arrays(stepPath, { minSize: 1, maxSize: 2 }));
      const other = tc.draw(gs.arrays(stepPath, { minSize: one.length, maxSize: one.length }));
      const criterion = compare({ paths: one }, { paths: other }).criteria[0]!;
      const words = (gaps: readonly TraceGap[]): string[] => [...new Set(gaps.map((gap) => gap.gap))].sort();
      const alike = (criterion.steps ?? []).every(
        (step) => step.ran === "both" && step.changed.length === 0 && step.open.every(({ a, b }) => a.at_least === b.at_least && a.at_most === b.at_most) && words(step.gaps.a).join() === words(step.gaps.b).join(),
      );
      expect(criterion.result === "same_so_far").toBe(criterion.steps !== undefined && alike);
    }));

  it("labels a difference on a marked table with what it holds and changes nothing else it lists, and reads a criterion that differs only there as marked_only", () =>
    hegel.test((tc) => {
      const one = tc.draw(gs.arrays(stepPath, { minSize: 1, maxSize: 2 }));
      const other = tc.draw(gs.arrays(stepPath, { minSize: one.length, maxSize: one.length }));
      const mark = (paths: readonly StepPath[]): StepPath[] =>
        paths.map((path) => ({ ...path, entries: path.entries.map((entry) => (entry.kind === "db" && entry.table === "rooms" ? { ...entry, holds: "bookkeeping" as const } : entry)) }));
      const plain = compare({ paths: one }, { paths: other }).criteria[0]!;
      const marked = compare({ paths: mark(one) }, { paths: mark(other) }).criteria[0]!;
      const unlabelled = (marked.steps ?? []).map((step) =>
        step.ran === "both" ? { ...step, changed: step.changed.map(({ holds: _, ...difference }) => difference), open: step.open.map(({ holds: _, ...difference }) => difference) } : step,
      );
      expect(unlabelled).toEqual(plain.steps ?? []);
      const differences = (marked.steps ?? []).flatMap((step) => (step.ran === "both" ? [...step.changed, ...step.open] : []));
      for (const difference of differences) expect(difference.holds !== undefined).toBe(difference.kind === "db" && difference.table === "rooms");
      const onlyMarked = (marked.steps ?? []).length > 0 && (marked.steps ?? []).every((step) => step.ran === "both") && differences.every((difference) => difference.holds !== undefined);
      expect(marked.result === "marked_only").toBe(onlyMarked);
      if (marked.result !== "marked_only") expect(marked.result === "same").toBe(plain.result === "same");
    }));

  it("compares two environments by their steps, names a step that ran on one side only, and keeps the flag out", () => {
    const off = [whole({ requests: [REQUESTS[1]], entries: [{ kind: "flag", name: "quick_reorder", side: "off", count: 1, gates: ["boolean"] }] })];
    const on = [
      whole({ requests: [REQUESTS[0]], entries: [{ kind: "flag", name: "quick_reorder", side: "on", count: 1, gates: ["boolean"] }] }),
      whole({ requests: [{ method: "POST", route: "/scores", status: 303 }], entries: [{ kind: "db", table: "scores", op: "insert", count: 1 }] }),
    ];
    expect(compare({ paths: off }, { paths: on })).toEqual({
      between: { kind: "condition", name: "quick_reorder", a: false, b: true },
      a: { world: "head", environment: "reorder-off" },
      b: { world: "head", environment: "reorder-on" },
      unread: null,
      counts: { changed: 1, open: 0, same_so_far: 0, marked_only: 0, same: 0, not_compared: 0 },
      criteria: [
        {
          feature: FEATURE,
          line: 3,
          name: "a reorder goes through",
          result: "changed",
          a: { scenario_record_id: "scn-reorder-off-3", outcome: "broke", line: 4 },
          b: { scenario_record_id: "scn-reorder-on-3", outcome: "pass" },
          steps: [
            {
              line: 4,
              text: "step 1",
              ran: "both",
              changed: [
                { kind: "request", method: "POST", route: "/reorders", status: 201, a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } },
                { kind: "request", method: "POST", route: "/reorders", status: 403, a: { at_least: 1, at_most: 1 }, b: { at_least: 0, at_most: 0 } },
              ],
              open: [],
              gaps: { a: [], b: [] },
            },
            { line: 5, text: "step 2", ran: "b" },
          ],
        },
      ],
      not_compared: [],
    });
  });

  it("leaves a count open while a job is pending, and keeps a request exact, since every request line is in", () => {
    const pending = whole({ requests: [REQUESTS[0]], entries: [{ kind: "db", table: "scores", op: "insert", count: 1 }], open: [GAPS[0]!] });
    const done = whole({ requests: [REQUESTS[0]], entries: [{ kind: "db", table: "scores", op: "insert", count: 1 }, { kind: "db", table: "rankings", op: "update", count: 1 }] });
    const criterion = compare({ paths: [pending] }, { paths: [done] }).criteria[0]!;
    expect(criterion.result).toBe("open");
    expect(criterion.steps).toEqual([
      {
        line: 4,
        text: "step 1",
        ran: "both",
        changed: [],
        open: [
          { kind: "db", table: "rankings", op: "update", a: { at_least: 0, at_most: null }, b: { at_least: 1, at_most: 1 } },
          { kind: "db", table: "scores", op: "insert", a: { at_least: 1, at_most: null }, b: { at_least: 1, at_most: 1 } },
        ],
        gaps: { a: [GAPS[0]], b: [] },
      },
    ]);
  });

  it("reads both sides' pending jobs, with one count each, as the same so far, and one pending job against none as open", () => {
    const pending = whole({ requests: [REQUESTS[0]], entries: [{ kind: "db", table: "scores", op: "insert", count: 1 }], open: [GAPS[0]!] });
    const later = whole({ requests: [REQUESTS[0]], entries: [{ kind: "db", table: "scores", op: "insert", count: 1 }], open: [{ gap: "jobs-pending", job_ids: ["77aa"] }] });
    const alike = compare({ paths: [pending] }, { paths: [later] });
    expect(alike.counts).toEqual({ changed: 0, open: 0, same_so_far: 1, marked_only: 0, same: 0, not_compared: 0 });
    expect(alike.criteria[0]!.steps).toEqual([
      { line: 4, text: "step 1", ran: "both", changed: [], open: [{ kind: "db", table: "scores", op: "insert", a: { at_least: 1, at_most: null }, b: { at_least: 1, at_most: null } }], gaps: { a: [GAPS[0]], b: [{ gap: "jobs-pending", job_ids: ["77aa"] }] } },
    ]);
    const more = whole({ requests: [REQUESTS[0]], entries: [{ kind: "db", table: "scores", op: "insert", count: 2 }], open: [GAPS[0]!] });
    expect(compare({ paths: [pending] }, { paths: [more] }).criteria[0]!.result).toBe("open");
  });

  it("pairs every two environments whose conditions differ in exactly one, the side without it first", () => {
    const other: RunEnvironment = { name: "reorder-v2", target_version: null, conditions: { quick_reorder: true, layout: "v2" } };
    const paths = [whole()];
    const document = documentOf([{ line: 3, name: "a reorder goes through", steps: 1, sides: { "reorder-on": { paths }, "reorder-off": { paths }, "reorder-v2": { paths } } }], [ON, OFF, other]);
    expect(comparePaths(document).map((comparison) => [comparison.between, comparison.a.environment, comparison.b.environment])).toEqual([
      [{ kind: "condition", name: "quick_reorder", a: false, b: true }, "reorder-off", "reorder-on"],
      [{ kind: "condition", name: "layout", a: null, b: "v2" }, "reorder-on", "reorder-v2"],
    ]);
  });

  it("says once why a pair was not read, and gives no pair when neither side read events", () => {
    const criterion = { line: 3, name: "a reorder goes through", steps: 1, sides: { "reorder-off": { paths: [whole()] }, "reorder-on": { paths: [undefined] } } };
    const atUrl = comparePaths(documentOf([criterion], [OFF, ON], [world("reorder-off"), world("reorder-on", null)]));
    expect(atUrl).toEqual([
      {
        between: { kind: "condition", name: "quick_reorder", a: false, b: true },
        a: { world: "head", environment: "reorder-off" },
        b: { world: "head", environment: "reorder-on" },
        unread: "world reorder-on runs at http://127.0.0.1:4100, which nukadoko did not start, so it read no execution events there",
        counts: { changed: 0, open: 0, same_so_far: 0, marked_only: 0, same: 0, not_compared: 0 },
        criteria: [],
        not_compared: [],
      },
    ]);
    expect(comparePaths(documentOf([criterion], [OFF, ON], [world("reorder-off", "unnamed"), world("reorder-on", "unnamed")]))).toEqual([]);
  });

  it("names a criterion that did not run on a side as not compared", () => {
    const document = documentOf([{ line: 3, name: "a reorder goes through", steps: 1, sides: { "reorder-on": { paths: [whole()] } } }]);
    expect(comparePaths(document)[0]).toMatchObject({ counts: { changed: 0, open: 0, same_so_far: 0, marked_only: 0, same: 0, not_compared: 1 }, criteria: [], not_compared: [{ feature: FEATURE, line: 3, reason: "did not run in reorder-off" }] });
  });
});

const placed = (): BaseCriterion => ({
    line: 3,
    name: "a reorder goes through",
    steps: 2,
    change: "new",
    sides: {
      "reorder-off": { paths: [whole({ entries: [flag("on")] }), whole({ entries: [{ kind: "db", table: "orders", op: "insert", count: 1 }] })] },
      "reorder-on": { paths: [whole({ entries: [flag("on")] }), whole({ entries: [{ kind: "db", table: "orders", op: "insert", count: 1 }] })] },
    },
    base: { "reorder-off": { paths: [whole({ entries: [flag("off")] })] }, "reorder-on": { paths: [whole({ entries: [flag("off")] })] } },
});
const opened = (): BaseCriterion => ({ line: 7, name: "an order is opened", steps: 1, change: "unchanged", sides: { "reorder-off": { paths: [whole()] }, "reorder-on": { paths: [whole()] } }, base: {} });

describe("comparePaths against the base", () => {

  it("pairs each environment's base with its head, compares a flag's side, and names a criterion the base did not run", () => {
    const comparisons = comparePaths(baseDocumentOf([placed(), opened()]));
    expect(comparisons.map((comparison) => [comparison.between, comparison.a, comparison.b])).toEqual([
      [{ kind: "base" }, { world: "base", environment: "reorder-off" }, { world: "head", environment: "reorder-off" }],
      [{ kind: "base" }, { world: "base", environment: "reorder-on" }, { world: "head", environment: "reorder-on" }],
      [{ kind: "condition", name: "quick_reorder", a: false, b: true }, { world: "head", environment: "reorder-off" }, { world: "head", environment: "reorder-on" }],
    ]);
    expect(comparisons[0]).toEqual({
      between: { kind: "base" },
      a: { world: "base", environment: "reorder-off" },
      b: { world: "head", environment: "reorder-off" },
      unread: null,
      counts: { changed: 1, open: 0, same_so_far: 0, marked_only: 0, same: 0, not_compared: 1 },
      criteria: [
        {
          feature: FEATURE,
          line: 3,
          name: "a reorder goes through",
          result: "changed",
          a: { scenario_record_id: "scn-base-reorder-off-3", outcome: "broke", line: 4 },
          b: { scenario_record_id: "scn-reorder-off-3", outcome: "pass" },
          steps: [
            {
              line: 4,
              text: "step 1",
              ran: "both",
              changed: [
                { kind: "flag", name: "quick_reorder", side: "off", a: { at_least: 1, at_most: 1 }, b: { at_least: 0, at_most: 0 } },
                { kind: "flag", name: "quick_reorder", side: "on", a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } },
              ],
              open: [],
              gaps: { a: [], b: [] },
            },
            { line: 5, text: "step 2", ran: "b" },
          ],
        },
      ],
      not_compared: [{ feature: FEATURE, line: 7, reason: "did not run at the base" }],
    });
  });

  it("compares no row whose head cell is a control or did not run, since the base never runs one", () => {
    const tagged = baseDocumentOf([placed()]);
    const document: RunDocument = {
      ...tagged,
      table: { ...tagged.table, rows: tagged.table.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => (cell.world === "head" && cell.environment === "reorder-off" ? { ...cell, role: "control" as const } : cell)) })) },
    };
    const [off] = comparePaths(document);
    expect(off).toMatchObject({ a: { environment: "reorder-off" }, counts: { changed: 0, open: 0, same_so_far: 0, marked_only: 0, same: 0, not_compared: 0 }, criteria: [], not_compared: [] });
  });

  it("says why a base whose program file names no {events} was not compared, and gives no base pair when neither side read events", () => {
    const unnamed = [OFF, ON].flatMap((environment) => [world(environment.name), world(environment.name, "unnamed", "base")]);
    expect(comparePaths(baseDocumentOf([placed()], [OFF, ON], unnamed)).filter((comparison) => comparison.between.kind === "base")).toEqual(
      ["reorder-off", "reorder-on"].map((environment) => ({
        between: { kind: "base" },
        a: { world: "base", environment },
        b: { world: "head", environment },
        unread: "the base's program file names no {events}, so the base world wrote no execution events",
        counts: { changed: 0, open: 0, same_so_far: 0, marked_only: 0, same: 0, not_compared: 0 },
        criteria: [],
        not_compared: [],
      })),
    );
    const none = [OFF, ON].flatMap((environment) => [world(environment.name, "unnamed"), world(environment.name, "unnamed", "base")]);
    expect(comparePaths(baseDocumentOf([placed()], [OFF, ON], none))).toEqual([]);
  });

  it("reads a row the base ran for paths alone from what its execution came to, since no cell holds it", () => {
    const room: BaseCriterion = {
      ...opened(),
      steps: 2,
      sides: { "reorder-off": { paths: [whole(), whole({ entries: [{ kind: "error", class: "CacheMiss", handled: true, count: 1 }] })] }, "reorder-on": { paths: [whole(), whole()] } },
      base: { "reorder-off": { paths: [whole()] }, "reorder-on": { paths: [whole(), whole()] } },
    };
    const document = baseDocumentOf([room]);
    expect(document.table.rows[0]!.cells.map((cell) => cell.world)).toEqual(["head", "head"]);
    const [off, on] = comparePaths(document);
    expect(off!.criteria).toEqual([
      {
        feature: FEATURE,
        line: 7,
        name: "an order is opened",
        result: "changed",
        a: { scenario_record_id: "scn-base-reorder-off-7", outcome: "broke", line: 8 },
        b: { scenario_record_id: "scn-reorder-off-7", outcome: "pass" },
        steps: [{ line: 9, text: "step 2", ran: "b" }],
      },
    ]);
    expect(on).toMatchObject({ counts: { changed: 0, open: 0, same_so_far: 0, marked_only: 0, same: 1, not_compared: 0 }, criteria: [{ line: 7, result: "same", a: { outcome: "pass" } }] });
  });

  it("reads a base world that did not start in an environment as each of its criteria not run at the base", () => {
    const [off] = comparePaths(baseDocumentOf([opened()], [OFF, ON], [world("reorder-off"), world("reorder-on")]));
    expect(off).toMatchObject({ unread: null, criteria: [], not_compared: [{ feature: FEATURE, line: 7, reason: "did not run at the base" }] });
  });
});

describe("the Changed paths section of the summary", () => {
  const section = (document: RunDocument): string[] => {
    const lines = renderRunSummary({ ...document, paths: comparePaths(document) }).split("\n");
    const start = lines.indexOf("## Changed paths");
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    return start === -1 ? [] : lines.slice(start, end === -1 ? undefined : end);
  };

  it("lists each changed or open criterion, errors first, then writes, an open one after every changed one, and one the same so far last, in one line", () => {
    const reorder: Criterion = {
      line: 3,
      name: "a reorder goes through",
      steps: 2,
      sides: {
        "reorder-off": { paths: [whole({ requests: [REQUESTS[1]] })] },
        "reorder-on": { paths: [whole({ requests: [REQUESTS[0]] }), whole({ requests: [{ method: "POST", route: "/scores", status: 303 }], entries: [{ kind: "db", table: "scores", op: "insert", count: 1 }, { kind: "job", name: "ScoreRecalcJob", phase: "enqueue", count: 1 }] })] },
      },
    };
    const receipt: Criterion = {
      line: 7,
      name: "a receipt goes out",
      steps: 1,
      sides: {
        "reorder-off": { paths: [whole({ entries: [{ kind: "db", table: "receipts", op: "insert", count: 2 }] })] },
        "reorder-on": { paths: [whole({ entries: [{ kind: "db", table: "receipts", op: "insert", count: 1 }], open: [GAPS[0]!] })] },
      },
    };
    const opened: Criterion = { line: 10, name: "an order is opened", steps: 1, sides: { "reorder-off": { paths: [whole({ requests: [REQUESTS[0]] })] }, "reorder-on": { paths: [whole({ requests: [REQUESTS[0]] })] } } };
    const rooms: Criterion = {
      line: 13,
      name: "a room is closed",
      steps: 1,
      sides: {
        "reorder-off": { paths: [whole({ entries: [{ kind: "db", table: "rooms", op: "update", count: 1 }] })] },
        "reorder-on": { paths: [whole({ entries: [{ kind: "error", class: "CacheMiss", handled: true, count: 1 }, { kind: "db", table: "rooms", op: "update", count: 2 }] })] },
      },
    };
    const parked: Criterion = {
      line: 2,
      name: "a parked score is placed",
      steps: 1,
      sides: {
        "reorder-off": { paths: [whole({ entries: [{ kind: "db", table: "scores", op: "insert", count: 1 }], open: [GAPS[0]!] })] },
        "reorder-on": { paths: [whole({ entries: [{ kind: "db", table: "scores", op: "insert", count: 1 }], open: [GAPS[0]!] })] },
      },
    };
    expect(section(documentOf([parked, reorder, receipt, opened, rooms]))).toEqual([
      "## Changed paths",
      "",
      "Each criterion below did something else on one side than on the other, or may have, step by step, as the program's execution events report it. " +
        "A count that a side's missing lines could still reach is listed as open, never as a change. " +
        "A criterion whose open counts read the same on both sides, under the same gaps, is the same so far, and comes last. " +
        "Between two environments, what they switch is named in the heading, so no flag's side is listed among the changes.",
      "",
      "### `reorder-off` → `reorder-on` (`quick_reorder` false → true)",
      "",
      "5 criteria compared: 2 changed, 1 open, 1 the same so far, 1 the same.",
      "",
      "- `features/orders.feature:13` a room is closed",
      "  - line 14 `step 1`: errors `CacheMiss` handled 0 → 1; writes `rooms` update 1 → 2",
      "- `features/orders.feature:3` a reorder goes through",
      "  - line 4 `step 1`: requests `POST /reorders` 403 → 201",
      "  - line 5 ran only in `reorder-on`, since `reorder-off` stopped at line 4 (`broke@4`): 1 write, 1 job, 1 request",
      "- `features/orders.feature:7` a receipt goes out",
      "  - line 8 `step 1`: open, since `reorder-on` is not whole (`jobs-pending` 1 job): writes `receipts` insert 2 → 1 or more",
      "- `features/orders.feature:2` a parked score is placed: the same so far, with `jobs-pending` on both sides",
      "",
    ]);
  });

  it("lists at most 20 criteria of a pair and points to run.json for the rest", () => {
    const criteria = Array.from({ length: 23 }, (_, index): Criterion => ({
      line: 3 + index * 3,
      name: `criterion ${index}`,
      steps: 1,
      sides: { "reorder-off": { paths: [whole({ requests: [REQUESTS[1]] })] }, "reorder-on": { paths: [whole({ requests: [REQUESTS[0]] })] } },
    }));
    const lines = section(documentOf(criteria));
    expect(lines.filter((line) => line.startsWith("- `"))).toHaveLength(20);
    expect(lines.at(-2)).toBe("- and 3 more in run.json's `paths`");
  });

  it("says why a pair was not compared, and why a criterion was not", () => {
    const unread = documentOf([{ line: 3, name: "a reorder goes through", steps: 1, sides: { "reorder-off": { paths: [whole()] }, "reorder-on": { paths: [undefined] } } }], [OFF, ON], [world("reorder-off"), world("reorder-on", null)]);
    expect(section(unread).slice(4)).toEqual([
      "### `reorder-off` → `reorder-on` (`quick_reorder` false → true)",
      "",
      "Not compared: world reorder-on runs at http://127.0.0.1:4100, which nukadoko did not start, so it read no execution events there.",
      "",
    ]);
    const missing = documentOf([
      { line: 3, name: "a reorder goes through", steps: 1, sides: { "reorder-on": { paths: [whole()] } } },
      { line: 6, name: "an order is opened", steps: 1, sides: { "reorder-on": { paths: [whole()] }, "reorder-off": { paths: [whole()] } } },
    ]);
    expect(section(missing)[6]).toBe("1 criterion compared: 1 the same. 1 criterion did not run in reorder-off, so its path was not compared.");
  });

  it("lists the base pairs under one heading, a criterion with the same lines in each environment once, and a flag whose side changed as one difference", () => {
    const receipt: BaseCriterion = {
      line: 10,
      name: "a receipt goes out",
      steps: 1,
      change: "changed",
      sides: { "reorder-off": { paths: [whole({ entries: [flag("off", "receipt_v2")] })] }, "reorder-on": { paths: [whole({ entries: [{ kind: "error", class: "Timeout", handled: true, count: 1 }] })] } },
      base: { "reorder-off": { paths: [whole()] }, "reorder-on": { paths: [whole()] } },
    };
    const lines = section(baseDocumentOf([placed(), opened(), receipt]));
    expect(lines.slice(0, lines.indexOf("### `reorder-off` → `reorder-on` (`quick_reorder` false → true)"))).toEqual([
      "## Changed paths",
      "",
      lines[2],
      "",
      "### base → head",
      "",
      "2 criteria compared: 2 changed. 1 criterion did not run at the base, so its path was not compared.",
      "",
      "- `features/orders.feature:10` a receipt goes out, in `reorder-on`",
      "  - line 11 `step 1`: errors `Timeout` handled 0 → 1",
      "- `features/orders.feature:3` a reorder goes through, in `reorder-off`, `reorder-on`",
      "  - line 4 `step 1`: flags `quick_reorder` `off` → `on`",
      "  - line 5 ran only at head, since the base stopped at line 4 (`broke@4`): 1 write",
      "- `features/orders.feature:10` a receipt goes out, in `reorder-off`",
      "  - line 11 `step 1`: flags `receipt_v2` `off` not evaluated → evaluated",
      "",
    ]);
  });

  it("lists a write to a table the program marks after every other difference, under a line of its own, and never reads it as the same", () => {
    const visit = (count: number) => ({ kind: "db" as const, table: "events", op: "insert" as const, count, holds: "bookkeeping" as const });
    const cache = (count: number) => ({ kind: "db" as const, table: "solid_cache_entries", op: "insert" as const, count, holds: "infrastructure" as const });
    const dashboard: Criterion = {
      line: 3,
      name: "a dashboard is read",
      steps: 1,
      sides: { "reorder-off": { paths: [whole({ entries: [visit(1)] })] }, "reorder-on": { paths: [whole({ entries: [cache(1)] })] } },
    };
    const room: Criterion = {
      line: 6,
      name: "a room is closed",
      steps: 1,
      sides: {
        "reorder-off": { paths: [whole({ entries: [{ kind: "db", table: "rooms", op: "update", count: 1 }, visit(1)] })] },
        "reorder-on": { paths: [whole({ entries: [{ kind: "db", table: "rooms", op: "update", count: 2 }, visit(2)] })] },
      },
    };
    const document = documentOf([dashboard, room]);
    const [comparison] = comparePaths(document);
    expect(comparison!.counts).toEqual({ changed: 1, open: 0, same_so_far: 0, marked_only: 1, same: 0, not_compared: 0 });
    expect(comparison!.criteria.map((criterion) => [criterion.name, criterion.result])).toEqual([
      ["a dashboard is read", "marked_only"],
      ["a room is closed", "changed"],
    ]);
    // The path is what the program did: a marked difference stays, with
    // what its table holds.
    expect(comparison!.criteria[0]!.steps).toEqual([
      {
        line: 4,
        text: "step 1",
        ran: "both",
        changed: [
          { kind: "db", table: "events", op: "insert", holds: "bookkeeping", a: { at_least: 1, at_most: 1 }, b: { at_least: 0, at_most: 0 } },
          { kind: "db", table: "solid_cache_entries", op: "insert", holds: "infrastructure", a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } },
        ],
        open: [],
        gaps: { a: [], b: [] },
      },
    ]);
    expect(section(document).slice(6)).toEqual([
      "2 criteria compared: 1 changed, 1 different only in bookkeeping or infrastructure writes.",
      "",
      "- `features/orders.feature:6` a room is closed",
      "  - line 7 `step 1`: writes `rooms` update 1 → 2",
      "",
      "Bookkeeping and infrastructure writes that differ, which no sentence is about, though another reader of those tables may be:",
      "",
      "- `features/orders.feature:3` a dashboard is read",
      "  - line 4 `step 1`: writes `events` insert 1 → 0 (bookkeeping), `solid_cache_entries` insert 0 → 1 (infrastructure)",
      "- `features/orders.feature:6` a room is closed",
      "  - line 7 `step 1`: writes `events` insert 1 → 2 (bookkeeping)",
      "",
    ]);
  });

  it("says once that the base's program file names no {events}", () => {
    const unnamed = [OFF, ON].flatMap((environment) => [world(environment.name), world(environment.name, "unnamed", "base")]);
    const lines = section(baseDocumentOf([placed()], [OFF, ON], unnamed));
    expect(lines.slice(4, 8)).toEqual(["### base → head", "", "Not compared: the base's program file names no {events}, so the base world wrote no execution events.", ""]);
  });
});
