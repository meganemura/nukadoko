import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { readCriterionTags, roleIn } from "../src/condition/condition.js";
import type { RunCellOutcome, RunTableCell } from "../src/record/run-result.js";
import {
  buildTable,
  executionOutcome,
  foldCell,
  hasRequiredCell,
  judgeRow,
  leftOutText,
  needsProofRun,
  rolesOf,
  rowsWithoutRequiredCell,
  type ExecutionOutcome,
} from "../src/run/verdict-table.js";

// Responsibility: the verdict table's pure parts (src/run/verdict-table.ts).
// Each verdict word comes from exactly its cell pattern, a control never
// turns a row red, a control proves only after `--proof-runs` agreeing
// failures at one Then line, and a cell folds its executions so that runs
// that disagree are flaky. The exact run.json and summary shapes a real run
// writes are in tests/run-verdict-table.test.ts.

const line = gs.integers({ minValue: 3, maxValue: 6 });
const outcome: Generator<ExecutionOutcome> = gs.oneOf(
  gs.just<ExecutionOutcome>({ kind: "pass" }),
  line.map((at): ExecutionOutcome => ({ kind: "fail", line: at })),
  line.map((at): ExecutionOutcome => ({ kind: "broke", line: at })),
);

const cellOutcome = gs.sampledFrom<RunCellOutcome>(["pass", "fail", "broke", "flaky", "not-run"]);
const cell = gs
  .tuples(gs.sampledFrom(["required", "control"] as const), cellOutcome, line, gs.integers({ minValue: 1, maxValue: 4 }))
  .map(([role, cellResult, at, runs]): Omit<RunTableCell, "environment"> => ({
    world: "head",
    role,
    conditions: {},
    outcome: cellResult,
    ...(cellResult === "pass" || cellResult === "not-run" ? {} : { line: at }),
    runs: cellResult === "not-run" ? 0 : runs,
  }));
const cells = gs
  .arrays(cell, { maxSize: 4 })
  .map((drawn): RunTableCell[] => drawn.map((entry, index) => ({ ...entry, environment: `env-${index}` })));
const proofRuns = gs.integers({ minValue: 1, maxValue: 4 });

describe("foldCell", () => {
  it("gives what every execution came to when they agree, and flaky at the first that did not pass when they do not", () =>
    hegel.test((tc) => {
      const outcomes = tc.draw(gs.arrays(outcome, { minSize: 1, maxSize: 5 }));
      const folded = foldCell(outcomes);
      const first = outcomes[0]!;
      const agree = outcomes.every((entry) => entry.kind === first.kind && (entry.kind === "pass" || entry.line === (first as { line: number }).line));
      expect(folded.runs).toBe(outcomes.length);
      if (agree) {
        expect(folded.outcome).toBe(first.kind);
        expect(folded.line).toBe(first.kind === "pass" ? undefined : first.line);
      } else {
        expect(folded.outcome).toBe("flaky");
        expect(folded.line).toBe((outcomes.find((entry) => entry.kind !== "pass") as { line: number }).line);
      }
    }));

  it("is not-run with no execution", () => {
    expect(foldCell([])).toEqual({ outcome: "not-run", runs: 0 });
  });
});

describe("judgeRow", () => {
  it("calls a row failed exactly when it has no required cell or a required cell that did not pass", () =>
    hegel.test((tc) => {
      const row = tc.draw(cells);
      const required = row.filter((entry) => entry.role === "required");
      const red = required.length === 0 || required.some((entry) => entry.outcome !== "pass");
      expect(judgeRow(row, tc.draw(proofRuns)).verdict === "failed").toBe(red);
    }));

  it("calls a green row proven exactly when a control failed at a Then line in --proof-runs runs, and held otherwise", () =>
    hegel.test((tc) => {
      const row = tc.draw(cells);
      const runs = tc.draw(proofRuns);
      const { verdict } = judgeRow(row, runs);
      if (verdict === "failed") return;
      const proof = row.some((entry) => entry.role === "control" && entry.outcome === "fail" && entry.runs >= runs);
      expect(verdict).toBe(proof ? "proven" : "held");
    }));

  it("never turns a row red for what a control cell came to", () =>
    hegel.test((tc) => {
      const row = tc.draw(cells);
      const runs = tc.draw(proofRuns);
      const replaced = row.map((entry) => (entry.role === "control" ? { ...entry, outcome: tc.draw(cellOutcome), line: 9, runs: 1 } : entry));
      expect(judgeRow(replaced, runs).verdict === "failed").toBe(judgeRow(row, runs).verdict === "failed");
    }));

  it("says why in one sentence for each word", () => {
    const pass = (environment: string, role: "required" | "control"): RunTableCell => ({ world: "head", environment, role, conditions: {}, outcome: "pass", runs: 1 });
    expect(judgeRow([pass("flag-on", "required"), { ...pass("flag-off", "control"), outcome: "fail", line: 7, runs: 2 }], 2)).toEqual({
      verdict: "proven",
      reason: "passes in flag-on, and a claim broke at line 7 in flag-off, where its conditions do not hold, in each of 2 runs",
    });
    expect(judgeRow([pass("flag-on", "required"), { ...pass("flag-off", "control"), outcome: "fail", line: 7, runs: 1 }], 2)).toEqual({
      verdict: "held",
      reason: "passes in flag-on; no control shows a Then failing where its conditions do not hold (flag-off: fail@7)",
    });
    expect(judgeRow([pass("default", "required")], 2)).toEqual({ verdict: "held", reason: "passes in default" });
    expect(judgeRow([{ ...pass("flag-on", "required"), outcome: "broke", line: 5 }], 2)).toEqual({
      verdict: "failed",
      reason: "stopped at line 5 in flag-on before a claim there was judged",
    });
    expect(judgeRow([{ ...pass("flag-on", "required"), outcome: "flaky", line: 7, runs: 3 }], 2)).toEqual({
      verdict: "failed",
      reason: "its 3 runs in flag-on disagree, the first that did not pass at line 7",
    });
    expect(judgeRow([{ ...pass("flag-on", "required"), outcome: "not-run", runs: 0, reason: "a BeforeAll hook failed" }], 2)).toEqual({
      verdict: "failed",
      reason: "did not run in flag-on: a BeforeAll hook failed",
    });
    expect(judgeRow([pass("flag-off", "control")], 2)).toEqual({
      verdict: "failed",
      reason: "no environment of this run meets its conditions, so every cell is a control and nothing shows that it holds",
    });
  });
});

describe("--proof-runs", () => {
  // The scheduler src/cli/run.ts and src/run/run-concurrent.ts share: run
  // the control once, then again while needsProofRun says so. `program`
  // is what each successive run of the control would come to.
  function schedule(program: readonly ExecutionOutcome[], runs: number): ExecutionOutcome[] {
    const outcomes = [program[0]!];
    while (needsProofRun("control", outcomes, runs)) outcomes.push(program[outcomes.length]!);
    return outcomes;
  }

  it("makes a control fail@ and prove only after --proof-runs agreeing failures at one Then line", () =>
    hegel.test((tc) => {
      const runs = tc.draw(proofRuns);
      const program = tc.draw(gs.arrays(outcome, { minSize: 4, maxSize: 4 }));
      const outcomes = schedule(program, runs);
      const folded = foldCell(outcomes);
      const first = program[0]!;
      const agreeing = first.kind === "fail" && program.slice(0, runs).every((entry) => entry.kind === "fail" && entry.line === first.line);
      expect(folded.outcome === "fail" && folded.runs >= runs).toBe(agreeing);
      expect(outcomes.length).toBeLessThanOrEqual(Math.max(1, runs));
      const verdict = judgeRow(
        [
          { world: "head", environment: "on", role: "required", conditions: {}, outcome: "pass", runs: 1 },
          { world: "head", environment: "off", role: "control", conditions: {}, ...folded },
        ],
        runs,
      ).verdict;
      expect(verdict).toBe(agreeing ? "proven" : "held");
    }));

  it("stops at the first run that passes, breaks, or fails at another line", () =>
    hegel.test((tc) => {
      const runs = tc.draw(proofRuns);
      const program = tc.draw(gs.arrays(outcome, { minSize: 4, maxSize: 4 }));
      const outcomes = schedule(program, runs);
      const last = outcomes.at(-1)!;
      const first = outcomes[0]!;
      const stillAgreeing = first.kind === "fail" && last.kind === "fail" && last.line === first.line;
      if (outcomes.length < runs) expect(stillAgreeing).toBe(false);
    }));

  it("never runs a required cell again", () =>
    hegel.test((tc) => {
      expect(needsProofRun("required", tc.draw(gs.arrays(outcome, { maxSize: 4 })), tc.draw(proofRuns))).toBe(false);
    }));
});

describe("executionOutcome", () => {
  const step = (status: "passed" | "failed" | "skipped" | "undefined", kind?: string, at?: number) => ({
    status,
    ...(at === undefined ? {} : { line: at }),
    ...(kind === undefined ? {} : { error: { kind, message: "m" } }),
  });
  const execution = (steps: ReturnType<typeof step>[], hooks: { status: string }[] = []) =>
    ({ status: steps.every((entry) => entry.status === "passed") && hooks.every((hook) => hook.status === "passed") ? "passed" : "failed", line: 2, steps, hooks }) as never;
  const inThen = (index: number): boolean => index === 2;

  it("reads a claim broken in Then as fail at its line, and any other stop as broke", () => {
    expect(executionOutcome(execution([step("passed"), step("passed"), step("passed")]), inThen)).toEqual({ kind: "pass" });
    expect(executionOutcome(execution([step("passed"), step("passed"), step("failed", "claim_broken", 9)]), inThen)).toEqual({ kind: "fail", line: 9 });
    expect(executionOutcome(execution([step("passed"), step("passed"), step("failed", "claim_unjudged", 9)]), inThen)).toEqual({ kind: "broke", line: 9 });
    expect(executionOutcome(execution([step("passed"), step("failed", "claim_broken", 8), step("skipped")]), inThen)).toEqual({ kind: "broke", line: 8 });
    expect(executionOutcome(execution([step("failed", "step_error", 7), step("skipped"), step("skipped")]), inThen)).toEqual({ kind: "broke", line: 7 });
    expect(executionOutcome(execution([step("undefined", undefined, 7), step("skipped"), step("skipped")]), inThen)).toEqual({ kind: "broke", line: 7 });
    expect(executionOutcome(execution([step("passed"), step("passed"), step("passed")], [{ status: "failed" }]), inThen)).toEqual({ kind: "broke", line: 2 });
  });
});

describe("buildTable", () => {
  it("gives a row per criterion by feature and line, a cell per environment with its role, and the verdict", () => {
    const outcomes: Record<string, ExecutionOutcome[]> = {
      "b.feature:3:flag-on": [{ kind: "pass" }],
      "b.feature:3:flag-off": [{ kind: "pass" }],
      "a.feature:9:flag-on": [{ kind: "pass" }],
      "a.feature:9:flag-off": [
        { kind: "fail", line: 12 },
        { kind: "fail", line: 12 },
      ],
    };
    const table = buildTable({
      criteria: [
        { feature: "b.feature", line: 3, name: "plain", tags: ["@smoke"] },
        { feature: "a.feature", line: 9, name: "gated", tags: ["@with:banner", "@held"] },
      ],
      environments: [
        { name: "flag-off", conditions: { banner: false } },
        { name: "flag-on", conditions: { banner: true } },
      ],
      outcomes: (feature, at, environment) => outcomes[`${feature}:${at}:${environment}`] ?? [],
      notRunReason: () => undefined,
      proofRuns: 2,
      leftOut: 0,
    });
    expect(table).toEqual({
      base: null,
      mapping_changed: null,
      worlds: [
        { world: "head", environment: "flag-off" },
        { world: "head", environment: "flag-on" },
      ],
      rows: [
        {
          feature: "a.feature",
          line: 9,
          name: "gated",
          change: null,
          conditions: ["@with:banner", "@held"],
          cells: [
            { world: "head", environment: "flag-off", role: "control", conditions: { banner: false }, outcome: "fail", line: 12, runs: 2 },
            { world: "head", environment: "flag-on", role: "required", conditions: { banner: true }, outcome: "pass", runs: 1 },
          ],
          verdict: "proven",
          reason: "passes in flag-on, and a claim broke at line 12 in flag-off, where its conditions do not hold, in each of 2 runs",
        },
        {
          feature: "b.feature",
          line: 3,
          name: "plain",
          change: null,
          conditions: [],
          cells: [
            { world: "head", environment: "flag-off", role: "required", conditions: {}, outcome: "pass", runs: 1 },
            { world: "head", environment: "flag-on", role: "required", conditions: {}, outcome: "pass", runs: 1 },
          ],
          verdict: "held",
          reason: "passes in flag-off, flag-on",
        },
      ],
      left_out: 0,
    });
  });

  it("names on each cell the conditions its role came from, so the role reads back from the cell alone", () =>
    hegel.test((tc) => {
      const pooled = gs.sampledFrom(["a", "b"]);
      const tags = tc.draw(
        gs.arrays(gs.oneOf(pooled.map((n) => `@with:${n}`), pooled.map((n) => `@without:${n}`), pooled.map((n) => `@with:${n}=x`)), { maxSize: 3 }),
      );
      const declared = tc.draw(
        gs.optional(gs.arrays(gs.tuples(pooled, gs.oneOf(gs.booleans().map((b): boolean | string => b), gs.just<boolean | string>("x"))), { maxSize: 2 })),
      );
      const conditions = declared === null || declared === undefined ? undefined : Object.fromEntries(declared);
      const table = buildTable({
        criteria: [{ feature: "a.feature", line: 3, name: "s", tags }],
        environments: [{ name: "e", conditions }],
        outcomes: () => [{ kind: "pass" }],
        notRunReason: () => undefined,
        proofRuns: 2,
        leftOut: 0,
      });
      const cell = table.rows[0]!.cells[0]!;
      const named = new Set(tags.map((tag) => tag.replace(/^@with(out)?:/, "").replace(/=.*$/, "")));
      expect(Object.keys(cell.conditions).sort()).toEqual([...named].sort());
      const recorded = Object.fromEntries(Object.entries(cell.conditions).filter((entry): entry is [string, boolean | string] => entry[1] !== null));
      expect(roleIn(readCriterionTags(tags).conditions, recorded)).toBe(cell.role);
    }));

  const pooledName = gs.sampledFrom(["a", "b"]);
  const tagsOf = gs.arrays(gs.oneOf(pooledName.map((n) => `@with:${n}`), pooledName.map((n) => `@without:${n}`), pooledName.map((n) => `@with:${n}=x`)), { maxSize: 3 });
  const environmentsOf = gs
    .arrays(gs.optional(gs.arrays(gs.tuples(pooledName, gs.oneOf(gs.booleans().map((b): boolean | string => b), gs.just<boolean | string>("x"))), { maxSize: 2 })), {
      minSize: 1,
      maxSize: 3,
    })
    .map((drawn) => drawn.map((entries, index) => ({ name: `env-${index}`, conditions: entries === null || entries === undefined ? undefined : Object.fromEntries(entries) })));

  it("has a required cell exactly when one environment meets every condition tag", () =>
    hegel.test((tc) => {
      const tags = tc.draw(tagsOf);
      const environments = tc.draw(environmentsOf);
      const { conditions } = readCriterionTags(tags);
      expect(hasRequiredCell(tags, environments)).toBe(environments.some((environment) => roleIn(conditions, environment.conditions) === "required"));
      // A criterion with no condition tag is required everywhere.
      expect(hasRequiredCell([], environments)).toBe(true);
    }));

  it("gives each row with no required cell one failed finding, with a do: line that names an environment that meets it or checks the file", () =>
    hegel.test((tc) => {
      const environments = tc.draw(environmentsOf);
      const rows = tc.draw(gs.arrays(tagsOf, { maxSize: 3 })).map((tags, index) => ({
        feature: "features/a.feature",
        line: 3 + index,
        name: `s${index}`,
        change: null,
        conditions: tags,
        cells: rolesOf(tags, environments).map((role, at) => ({ world: "head" as const, environment: environments[at]!.name, role, conditions: {}, outcome: "pass" as const, runs: 1 })),
        verdict: "held" as const,
        reason: "",
      }));
      const elsewhere = tc.draw(gs.optional(gs.sampledFrom(["staging", "flag on"])));
      const findings = rowsWithoutRequiredCell({ rows }, environments, () => elsewhere ?? undefined);
      const red = rows.filter((row) => !hasRequiredCell(row.conditions, environments));
      expect(findings.map((finding) => finding.line)).toEqual(red.map((row) => row.line));
      for (const finding of findings) {
        expect(finding).toMatchObject({ severity: "failed", code: "criterion-without-required-cell", file: "features/a.feature" });
        expect(finding.message).toMatch(/no environment of this run meets (it|all of them): env-0 \(/);
        expect(finding.do).toBe(
          elsewhere === null || elsewhere === undefined ? "nuka check features/a.feature" : `nuka run features/a.feature:${finding.line} --env ${elsewhere === "staging" ? "staging" : "'flag on'"}`,
        );
      }
    }));

  it("says how many criteria --env left out, in the same words on stderr and in the summary", () => {
    expect(leftOutText(1)).toBe("1 criterion not run: its conditions hold in no selected environment");
    expect(leftOutText(3)).toBe("3 criteria not run: their conditions hold in no selected environment");
  });

  it("says why a cell with no execution did not run", () => {
    const table = buildTable({
      criteria: [{ feature: "a.feature", line: 3, name: "s", tags: [] }],
      environments: [
        { name: "one", conditions: undefined },
        { name: "two", conditions: undefined },
      ],
      outcomes: () => [],
      notRunReason: (environment) => (environment === "one" ? "a BeforeAll hook failed" : undefined),
      proofRuns: 2,
      leftOut: 0,
    });
    expect(table.rows[0]!.cells.map((entry) => entry.reason)).toEqual(["a BeforeAll hook failed", "no execution of it was recorded"]);
    expect(table.rows[0]!.reason).toBe("did not run in one: a BeforeAll hook failed");
  });
});
