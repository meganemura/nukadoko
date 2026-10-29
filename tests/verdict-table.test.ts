import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { readCriterionTags, roleIn } from "../src/condition/condition.js";
import { RED_VERDICTS, type RunCellOutcome, type RunRowVerdict, type RunTableCell } from "../src/record/run-result.js";
import {
  buildTable,
  executionOutcome,
  foldCell,
  foldHeadCell,
  hasRequiredCell,
  judgeRow,
  judgedRowFindings,
  leftOutText,
  needsProofRun,
  plannedWorldCells,
  rolesOf,
  rowsWithoutRequiredCell,
  type ExecutionOutcome,
  type RowContext,
} from "../src/run/verdict-table.js";

// Responsibility: the verdict table's pure parts (src/run/verdict-table.ts).
// Each verdict word comes from exactly its cell pattern, a control never
// turns a row red, a control proves only after `--proof-runs` agreeing
// failures (the same claim broken at one Then line, whatever value each
// run saw), and a cell folds its executions so that runs that disagree are
// flaky. Under `--base`, a base or an old cell joins the row: moved comes
// only from an unchanged row, unproven only from a new or changed one, and
// the cells a row plans in each world follow its change. The exact run.json
// and summary shapes a real run
// writes are in tests/run-verdict-table.test.ts.

const line = gs.integers({ minValue: 3, maxValue: 6 });
const outcome: Generator<ExecutionOutcome> = gs.oneOf(
  gs.just<ExecutionOutcome>({ kind: "pass" }),
  gs
    .tuples(line, gs.integers({ minValue: 0, maxValue: 1 }), gs.integers({ minValue: 400, maxValue: 503 }))
    .map(([at, claim, value]): ExecutionOutcome => ({ kind: "fail", line: at, claim, actual: { value } })),
  gs
    .tuples(line, gs.sampledFrom([undefined, "a Before hook failed before its steps ran", "an After hook failed after its steps passed"]))
    .map(([at, reason]): ExecutionOutcome => (reason === undefined ? { kind: "broke", line: at } : { kind: "broke", line: at, reason })),
);
/** Two executions agree: the same kind at the same line, for a fail the
 * same claim, whatever value each saw, and for a broke the same hook. */
const agrees = (a: ExecutionOutcome, b: ExecutionOutcome): boolean =>
  a.kind === b.kind &&
  (a.kind === "pass" ||
    (a.line === (b as { line: number }).line &&
      (a.kind !== "fail" || a.claim === (b as { claim: number }).claim) &&
      (a.kind !== "broke" || a.reason === (b as { reason?: string }).reason)));

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
      const agree = outcomes.every((entry) => agrees(entry, first));
      expect(folded.runs).toBe(outcomes.length);
      if (agree) {
        expect(folded.outcome).toBe(first.kind);
        expect(folded.line).toBe(first.kind === "pass" ? undefined : first.line);
        // A fail keeps the claim, and each run's value in run order.
        expect(folded.claim).toBe(first.kind === "fail" ? first.claim : undefined);
        expect(folded.actuals).toEqual(first.kind === "fail" ? outcomes.map((entry) => (entry as { actual: unknown }).actual) : undefined);
        // A broke keeps the hook every run failed in.
        expect(folded.reason).toBe(first.kind === "broke" ? first.reason : undefined);
      } else {
        expect(folded.outcome).toBe("flaky");
        expect(folded.line).toBe((outcomes.find((entry) => entry.kind !== "pass") as { line: number }).line);
      }
    }));

  it("is not-run with no execution", () => {
    expect(foldCell([])).toEqual({ outcome: "not-run", runs: 0 });
  });
});

describe("foldHeadCell", () => {
  it("never lets a control whose proof round did not finish prove, so a green new row still plans its base cell", () =>
    hegel.test((tc) => {
      const outcomes = tc.draw(gs.arrays(outcome, { maxSize: 4 }));
      const runs = tc.draw(proofRuns);
      const control = foldHeadCell(outcomes, "control", 3, "the worker of its proof run failed");
      expect(control).toEqual({ outcome: "broke", line: 3, runs: outcomes.length, reason: "the worker of its proof run failed" });
      const head = [{ environment: "on", role: "required" as const, outcome: "pass" as const, runs: 1 }, { environment: "off", role: "control" as const, ...control }];
      expect(plannedWorldCells(head, runs, { change: "new", held: false, mappingChanged: false, retagged: false, renamed: false }).base).toEqual(["on"]);
    }));

  it("folds a required cell, and a control whose proof rounds finished, as foldCell does", () =>
    hegel.test((tc) => {
      const outcomes = tc.draw(gs.arrays(outcome, { maxSize: 4 }));
      expect(foldHeadCell(outcomes, "control", 3, undefined)).toEqual(foldCell(outcomes));
      expect(foldHeadCell(outcomes, "required", 3, "the worker of its proof run failed")).toEqual(foldCell(outcomes));
    }));
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
    expect(judgeRow([{ ...pass("flag-on", "required"), outcome: "broke", line: 3, reason: "an After hook failed after its steps passed" }], 2)).toEqual({
      verdict: "failed",
      reason: "in flag-on, an After hook failed after its steps passed",
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

  it("makes a control fail@ and prove only after --proof-runs runs that broke the same claim at one Then line", () =>
    hegel.test((tc) => {
      const runs = tc.draw(proofRuns);
      const program = tc.draw(gs.arrays(outcome, { minSize: 4, maxSize: 4 }));
      const outcomes = schedule(program, runs);
      const folded = foldCell(outcomes);
      const first = program[0]!;
      const agreeing = first.kind === "fail" && program.slice(0, runs).every((entry) => agrees(entry, first));
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

  it("stops at the first run that passes, breaks, or breaks another claim or a claim at another line", () =>
    hegel.test((tc) => {
      const runs = tc.draw(proofRuns);
      const program = tc.draw(gs.arrays(outcome, { minSize: 4, maxSize: 4 }));
      const outcomes = schedule(program, runs);
      const last = outcomes.at(-1)!;
      const first = outcomes[0]!;
      const stillAgreeing = first.kind === "fail" && agrees(last, first);
      if (outcomes.length < runs) expect(stillAgreeing).toBe(false);
    }));

  it("never runs a required cell again", () =>
    hegel.test((tc) => {
      expect(needsProofRun("required", tc.draw(gs.arrays(outcome, { maxSize: 4 })), tc.draw(proofRuns))).toBe(false);
    }));
});

describe("executionOutcome", () => {
  const step = (status: "passed" | "failed" | "skipped" | "undefined", kind?: string, at?: number, claims?: object[]) => ({
    status,
    ...(at === undefined ? {} : { line: at }),
    ...(kind === undefined ? {} : { error: { kind, message: "m" } }),
    ...(claims === undefined ? {} : { claims }),
  });
  const held = { actual: 200, actual_from: "observe:status", compare: "equal", expected: 200, expected_from: "sentence:status", expected_text: "200", outcome: "held", measured: null };
  const broken = (actual: unknown) => ({ ...held, actual, outcome: "broken" });
  const execution = (steps: ReturnType<typeof step>[], hooks: { type?: string; status: string; step_index?: number }[] = []) =>
    ({ status: steps.every((entry) => entry.status === "passed") && hooks.every((hook) => hook.status === "passed") ? "passed" : "failed", line: 2, steps, hooks }) as never;
  const inThen = (index: number): boolean => index === 2;

  it("reads a claim broken in Then as fail at its line, and any other stop as broke", () => {
    expect(executionOutcome(execution([step("passed"), step("passed"), step("passed")]), inThen)).toEqual({ kind: "pass" });
    expect(executionOutcome(execution([step("passed"), step("passed"), step("failed", "claim_broken", 9, [held, broken(503)])]), inThen)).toEqual({
      kind: "fail",
      line: 9,
      claim: 1,
      actual: { value: 503 },
    });
    // A claim_broken step with no broken claim to point at cannot prove.
    expect(executionOutcome(execution([step("passed"), step("passed"), step("failed", "claim_broken", 9)]), inThen)).toEqual({ kind: "broke", line: 9 });
    expect(executionOutcome(execution([step("passed"), step("passed"), step("failed", "claim_unjudged", 9)]), inThen)).toEqual({ kind: "broke", line: 9 });
    expect(executionOutcome(execution([step("passed"), step("failed", "claim_broken", 8), step("skipped")]), inThen)).toEqual({ kind: "broke", line: 8 });
    expect(executionOutcome(execution([step("failed", "step_error", 7), step("skipped"), step("skipped")]), inThen)).toEqual({ kind: "broke", line: 7 });
    expect(executionOutcome(execution([step("undefined", undefined, 7), step("skipped"), step("skipped")]), inThen)).toEqual({ kind: "broke", line: 7 });
  });

  it("says why a pass judged no claim in Then position, as run.json's judged_by does", () => {
    const passed = [step("passed"), step("passed"), step("passed")];
    expect(executionOutcome({ ...(execution(passed) as object), judged_by: "compat" } as never, inThen)).toEqual({ kind: "pass", judgedBy: "compat" });
    expect(executionOutcome({ ...(execution(passed) as object), judged_by: "nothing" } as never, inThen)).toEqual({ kind: "pass", judgedBy: "nothing" });
  });

  it("names the hook that failed an execution none of whose steps failed, and when it ran", () => {
    const passed = [step("passed", undefined, 3), step("passed", undefined, 4), step("passed", undefined, 5)];
    expect(executionOutcome(execution(passed, [{ type: "before", status: "passed" }, { type: "after", status: "failed" }]), inThen)).toEqual({
      kind: "broke",
      line: 2,
      reason: "an After hook failed after its steps passed",
    });
    expect(executionOutcome(execution([step("passed", undefined, 3), step("skipped"), step("skipped")], [{ type: "after_step", status: "failed", step_index: 0 }, { type: "after", status: "failed" }]), inThen)).toEqual({
      kind: "broke",
      line: 2,
      reason: "an AfterStep hook failed after the step at line 3 passed",
    });
    expect(executionOutcome(execution([step("skipped"), step("skipped"), step("skipped")], [{ type: "before", status: "failed" }, { type: "after", status: "failed" }]), inThen)).toEqual({
      kind: "broke",
      line: 2,
      reason: "a Before hook failed before its steps ran",
    });
    // A step that failed is the stop, whatever a hook did after it.
    expect(executionOutcome(execution([step("passed"), step("failed", "step_error", 4), step("skipped")], [{ type: "after", status: "failed" }]), inThen)).toEqual({ kind: "broke", line: 4 });
  });

  it("names the broken claim's value as run.json holds it: whole, cut to the start of its JSON, missing, or an item's", () => {
    const outcomeOf = (claims: object[]) => executionOutcome(execution([step("passed"), step("passed"), step("failed", "claim_broken", 9, claims)]), inThen);
    expect(outcomeOf([{ ...broken('"' + "x".repeat(10)), actual_bytes: 4000 }])).toMatchObject({ claim: 0, actual: { json_start: '"' + "x".repeat(10), json_bytes: 4000 } });
    const { actual: _actual, ...noValue } = broken(0);
    expect(outcomeOf([{ ...noValue, reason: "observe:status held nothing" }])).toMatchObject({ claim: 0, actual: { reason: "observe:status held nothing" } });
    const each = {
      actual_from: "observe:items",
      each: {
        claims: [],
        items: 2,
        selected: 2,
        results: [
          { index: 1, selected: true, outcome: "broken", claims: [broken("chair")] },
          { index: 0, selected: true, outcome: "held", claims: [held] },
        ],
      },
      outcome: "broken",
      measured: null,
    };
    expect(outcomeOf([held, each])).toMatchObject({ claim: 1, actual: { value: "chair" } });
  });

  it("makes two runs that broke two claims of one Then line disagree, and two values of one claim agree", () => {
    const run = (claims: object[]) => executionOutcome(execution([step("passed"), step("passed"), step("failed", "claim_broken", 9, claims)]), inThen);
    expect(foldCell([run([broken("off"), held]), run([held, broken(503)])])).toEqual({ outcome: "flaky", line: 9, runs: 2 });
    expect(foldCell([run([held, broken(503)]), run([held, broken(404)])])).toEqual({
      outcome: "fail",
      line: 9,
      runs: 2,
      claim: 1,
      actuals: [{ value: 503 }, { value: 404 }],
    });
    expect(needsProofRun("control", [run([broken("off"), held]), run([held, broken(503)])], 3)).toBe(false);
  });
});

describe("buildTable", () => {
  it("gives a row per criterion by feature and line, a cell per environment with its role, and the verdict", () => {
    const outcomes: Record<string, ExecutionOutcome[]> = {
      "b.feature:3:flag-on": [{ kind: "pass" }],
      "b.feature:3:flag-off": [{ kind: "pass" }],
      "a.feature:9:flag-on": [{ kind: "pass" }],
      "a.feature:9:flag-off": [
        { kind: "fail", line: 12, claim: 0, actual: { value: 503 } },
        { kind: "fail", line: 12, claim: 0, actual: { value: 404 } },
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
      mapping_changes: null,
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
            {
              world: "head",
              environment: "flag-off",
              role: "control",
              conditions: { banner: false },
              outcome: "fail",
              line: 12,
              runs: 2,
              claim: 0,
              actuals: [{ value: 503 }, { value: 404 }],
            },
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
      proof_runs: 2,
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

  it("reads a control whose proof round went wrong as broke at its scenario line, with the reason, and leaves a required cell as it ran", () =>
    hegel.test((tc) => {
      const executions = tc.draw(gs.arrays(outcome, { minSize: 1, maxSize: 3 }));
      const role = tc.draw(gs.sampledFrom(["@with:banner", "@without:banner"]));
      const table = buildTable({
        criteria: [{ feature: "a.feature", line: 3, name: "s", tags: [role] }],
        environments: [{ name: "flag-off", conditions: { banner: false } }],
        outcomes: () => executions,
        notRunReason: () => undefined,
        proofRuns: 2,
        leftOut: 0,
        proofProblem: () => "the worker of its proof run failed: boom",
      });
      const cell = table.rows[0]!.cells[0]!;
      if (cell.role === "control") {
        expect(cell).toMatchObject({ outcome: "broke", line: 3, runs: executions.length, reason: "the worker of its proof run failed: boom" });
        expect(table.rows[0]!.verdict).not.toBe("proven");
      } else {
        expect(cell).toMatchObject(foldCell(executions));
        expect(cell.reason).toBe(foldCell(executions).reason);
      }
    }));

  it("gives an old cell the role and the conditions the base's environment has, and a column to one only the base selects", () => {
    const table = buildTable({
      criteria: [{ feature: "a.feature", line: 3, name: "s", tags: ["@with:flag"] }],
      environments: [
        { name: "a", conditions: { flag: true } },
        { name: "b", conditions: { flag: false } },
      ],
      outcomes: (_feature, _line, environment, world = "head") => (world === "old" && environment === "c" ? [{ kind: "fail", line: 5, claim: 0, actual: { value: 7 } }] : [{ kind: "pass" }]),
      notRunReason: () => undefined,
      proofRuns: 2,
      leftOut: 0,
      base: {
        ref: "main",
        commit: "0".repeat(40),
        mapping: { files: [], config: false, conditions: ["b"], default_environments: false, unseen: [] },
        mappingChanged: true,
        changeOf: () => ({ change: "unchanged" }),
        removed: [],
        oldEnvironments: [
          { name: "b", conditions: { flag: true } },
          { name: "c", conditions: { flag: true } },
        ],
      },
    });
    expect(table.worlds).toEqual([
      { world: "head", environment: "a" },
      { world: "head", environment: "b" },
      { world: "old", environment: "b" },
      { world: "old", environment: "c" },
    ]);
    const [row] = table.rows;
    expect(row!.cells.filter((entry) => entry.world === "old")).toEqual([
      { world: "old", environment: "b", role: "required", conditions: { flag: true }, outcome: "pass", runs: 1 },
      { world: "old", environment: "c", role: "required", conditions: { flag: true }, outcome: "fail", line: 5, runs: 1, claim: 0, actuals: [{ value: 7 }] },
    ]);
    expect(row!.verdict).toBe("moved");
  });

  it("says the mapping could not be compared, not that it changed, where an obstacle hid part of it", () => {
    const table = buildTable({
      criteria: [{ feature: "a.feature", line: 3, name: "s", tags: [] }],
      environments: [{ name: "default", conditions: undefined }],
      outcomes: (_feature, _line, _environment, world = "head") => (world === "head" ? [{ kind: "pass" }] : []),
      notRunReason: (_environment, world) => (world === "old" ? "steps is a symbolic link" : undefined),
      proofRuns: 2,
      leftOut: 0,
      base: {
        ref: "main",
        commit: "0".repeat(40),
        mapping: { files: [], config: false, conditions: [], default_environments: false, unseen: ["steps is a symbolic link"] },
        mappingChanged: true,
        changeOf: () => ({ change: "unchanged" }),
        removed: [],
        oldEnvironments: [{ name: "default", conditions: undefined }],
      },
    });
    const [row] = table.rows;
    expect(row!.verdict).toBe("moved");
    expect(row!.reason).toBe("passes in default, but the mapping could not be compared with the base's, and it did not run in the old world in default: steps is a symbolic link");
  });

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

describe("judgeRow under --base", () => {
  // A base or an old cell stands in a required head cell's environment,
  // so it carries the required role.
  const worldCell = (world: "base" | "old") =>
    gs.tuples(cellOutcome, line, gs.integers({ minValue: 1, maxValue: 4 }), gs.integers({ minValue: 0, maxValue: 3 })).map(
      ([cellResult, at, runs, index]): RunTableCell => ({
        world,
        environment: `env-${index}`,
        role: "required",
        conditions: {},
        outcome: cellResult,
        ...(cellResult === "pass" || cellResult === "not-run" ? {} : { line: at }),
        runs: cellResult === "not-run" ? 0 : runs,
      }),
    );
  const context = gs
    .tuples(gs.sampledFrom(["unchanged", "changed", "new"] as const), gs.booleans(), gs.booleans(), gs.booleans(), gs.booleans())
    .map(([change, held, mappingChanged, retagged, renamed]): RowContext => ({
      change,
      held,
      mappingChanged,
      retagged: change === "unchanged" && retagged,
      renamed: change === "unchanged" && renamed,
    }));
  const row = gs
    .tuples(cells, gs.arrays(worldCell("base"), { maxSize: 3 }), gs.arrays(worldCell("old"), { maxSize: 3 }))
    .map(([head, base, old]) => [...head, ...base, ...old]);
  const proof = (cell: RunTableCell, runs: number): boolean => cell.outcome === "fail" && cell.runs >= runs;

  // Each word, as docs/spec.md "Verdicts" states its pattern.
  function expectedWord(all: readonly RunTableCell[], runs: number, given: RowContext): RunRowVerdict {
    const head = all.filter((cell) => cell.world === "head");
    const required = head.filter((cell) => cell.role === "required");
    if (required.length === 0 || required.some((cell) => cell.outcome !== "pass")) return "failed";
    const controlProves = head.some((cell) => cell.role === "control" && proof(cell, runs));
    if (given.change === "unchanged") {
      const old = all.filter((cell) => cell.world === "old");
      const moved = (given.mappingChanged || given.retagged || given.renamed) && !(old.length > 0 && old.every((cell) => cell.outcome === "pass"));
      if (moved) return "moved";
      return controlProves ? "proven" : "held";
    }
    const base = all.filter((cell) => cell.world === "base");
    if (base.some((cell) => proof(cell, runs))) return "proven";
    if (controlProves) return "proven";
    if (given.held && base.length > 0 && base.every((cell) => cell.outcome === "pass")) return "held";
    return "unproven";
  }

  it("gives each word from exactly its pattern of worlds and cells", () =>
    hegel.test((tc) => {
      const all = tc.draw(row);
      const runs = tc.draw(proofRuns);
      const given = tc.draw(context);
      expect(judgeRow(all, runs, given).verdict).toBe(expectedWord(all, runs, given));
    }));

  it("never turns a row red for a control: a row red with its controls is red with them gone", () =>
    hegel.test((tc) => {
      const all = tc.draw(row);
      const runs = tc.draw(proofRuns);
      const given = tc.draw(context);
      const withoutControls = all.filter((cell) => !(cell.world === "head" && cell.role === "control"));
      if (RED_VERDICTS.has(judgeRow(all, runs, given).verdict)) expect(RED_VERDICTS.has(judgeRow(withoutControls, runs, given).verdict)).toBe(true);
    }));

  it("says moved only for an unchanged row, unproven only for a new or changed one, and removed never for a row head holds", () =>
    hegel.test((tc) => {
      const all = tc.draw(row);
      const given = tc.draw(context);
      const { verdict } = judgeRow(all, tc.draw(proofRuns), given);
      if (verdict === "moved") expect(given.change).toBe("unchanged");
      if (verdict === "unproven") expect(given.change).not.toBe("unchanged");
      expect(verdict).not.toBe("removed");
    }));

  it("reads an unchanged row's cells as a run without --base does, unless the old world shows its meaning moved", () =>
    hegel.test((tc) => {
      // A green head, so its controls decide the word.
      const required = tc.draw(gs.integers({ minValue: 1, maxValue: 2 }));
      const controls = tc.draw(gs.arrays(cell, { maxSize: 3 })).map((entry): RunTableCell => ({ ...entry, role: "control", environment: "" }));
      const head = [...Array.from({ length: required }, (): RunTableCell => ({ world: "head", environment: "", role: "required", conditions: {}, outcome: "pass", runs: 1 })), ...controls].map(
        (entry, index) => ({ ...entry, environment: `env-${index}` }),
      );
      const old = tc.draw(gs.arrays(worldCell("old"), { maxSize: 2 }));
      const runs = tc.draw(proofRuns);
      const given: RowContext = { ...tc.draw(context), change: "unchanged" };
      const verdict = judgeRow([...head, ...old], runs, given).verdict;
      if (verdict !== "moved") expect(verdict).toBe(judgeRow(head, runs).verdict);
    }));

  it("gives a run without --base only held, proven, or failed", () =>
    hegel.test((tc) => {
      expect(["held", "proven", "failed"]).toContain(judgeRow(tc.draw(row), tc.draw(proofRuns)).verdict);
    }));

  it("plans a base cell only for a new or changed row and an old cell only for an unchanged one under a changed mapping, each where head passed", () =>
    hegel.test((tc) => {
      const head = tc.draw(cells);
      const runs = tc.draw(proofRuns);
      const given = tc.draw(context);
      const planned = plannedWorldCells(head, runs, given);
      const required = head.filter((cell) => cell.role === "required");
      const green = required.length > 0 && required.every((cell) => cell.outcome === "pass");
      const passedIn = required.map((cell) => cell.environment);
      const controlProves = head.some((cell) => cell.role === "control" && proof(cell, runs));
      expect(planned.old).toEqual(green && given.change === "unchanged" && (given.mappingChanged || given.retagged || given.renamed) ? passedIn : []);
      expect(planned.base).toEqual(green && given.change !== "unchanged" && (given.held || !controlProves) ? passedIn : []);
      expect(plannedWorldCells(head, runs, undefined)).toEqual({ base: [], old: [] });
    }));

  it("plans an unchanged row's old cells where the old world's environments require it, whatever head's roles are", () =>
    hegel.test((tc) => {
      const head = tc.draw(cells);
      const runs = tc.draw(proofRuns);
      const given: RowContext = { ...tc.draw(context), change: "unchanged" };
      const oldRoles = tc
        .draw(gs.arrays(gs.sampledFrom(["required", "control"] as const), { maxSize: 4 }))
        .map((role, index) => ({ environment: `old-${index}`, role }));
      const planned = plannedWorldCells(head, runs, given, oldRoles);
      const required = head.filter((cell) => cell.role === "required");
      const green = required.length > 0 && required.every((cell) => cell.outcome === "pass");
      const oldRequired = oldRoles.filter((cell) => cell.role === "required").map((cell) => cell.environment);
      expect(planned).toEqual({ base: [], old: green && (given.mappingChanged || given.retagged || given.renamed) ? oldRequired : [] });
    }));

  it("never calls a retagged or renamed row held without an old cell that passed", () =>
    hegel.test((tc) => {
      const all = tc.draw(row);
      const renamed = tc.draw(gs.booleans());
      const given: RowContext = { ...tc.draw(context), change: "unchanged", retagged: !renamed, renamed };
      const { verdict } = judgeRow(all, tc.draw(proofRuns), given);
      const old = all.filter((cell) => cell.world === "old");
      if (verdict === "held") expect(old.length > 0 && old.every((cell) => cell.outcome === "pass")).toBe(true);
      const head = all.filter((cell) => cell.world === "head");
      const planned = plannedWorldCells(head, tc.draw(proofRuns), given);
      const required = head.filter((cell) => cell.role === "required");
      if (required.length > 0 && required.every((cell) => cell.outcome === "pass")) expect(planned.old.length).toBeGreaterThan(0);
    }));

  it("runs a base cell again for proof as it runs a head control, and never an old cell", () =>
    hegel.test((tc) => {
      const runs = tc.draw(proofRuns);
      const outcomes = tc.draw(gs.arrays(outcome, { maxSize: 4 }));
      expect(needsProofRun("required", outcomes, runs, "base")).toBe(needsProofRun("control", outcomes, runs, "head"));
      expect(needsProofRun("required", outcomes, runs, "old")).toBe(false);
    }));

  it("names each environment as it is spelled, whatever characters its name holds", () =>
    hegel.test((tc) => {
      // A name holds characters a replacement string reads as a pattern
      // (`$&`, `$$`, `$\``), which must reach the reason as written.
      const name = gs.text({ minSize: 1, maxSize: 6, alphabet: "a$&\x60'" });
      const first = tc.draw(name);
      const second = tc.draw(name.filter((value) => value !== first));
      const pass = (environment: string): RunTableCell => ({ world: "head", environment, role: "required", conditions: {}, outcome: "pass", runs: 1 });
      const notRun = (environment: string): RunTableCell => ({ world: "old", environment, role: "required", conditions: {}, outcome: "not-run", runs: 0, reason: "the config file did not load" });
      expect(judgeRow([pass(first), pass(second), notRun(first), notRun(second)], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false }).reason).toBe(
        `passes in ${first}, ${second}, but the mapping changed since the base, and it did not run in the old world in ${first}, ${second}: the config file did not load`,
      );
    }));

  it("says why in one sentence for each word", () => {
    const head: RunTableCell = { world: "head", environment: "default", role: "required", conditions: {}, outcome: "pass", runs: 1 };
    const at = (world: "base" | "old", outcomeOf: RunCellOutcome, extra: Partial<RunTableCell> = {}): RunTableCell => ({ world, environment: "default", role: "required", conditions: {}, outcome: outcomeOf, runs: 1, ...extra });
    expect(judgeRow([head], 2, { change: "unchanged", held: false, mappingChanged: false, retagged: false, renamed: false })).toEqual({
      verdict: "held",
      reason: "passes in default, and neither it nor the mapping changed since the base",
    });
    expect(judgeRow([head, at("old", "pass")], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false })).toEqual({
      verdict: "held",
      reason: "passes in default, and in the old world, where the base's mapping runs head's code",
    });
    expect(judgeRow([head, at("old", "broke", { line: 4 })], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false })).toEqual({
      verdict: "moved",
      reason: "passes in default, but the mapping changed since the base, and it stopped at line 4 of the base's feature file in the old world in default before a claim there was judged",
    });
    expect(judgeRow([head, at("old", "broke", { line: 3, reason: "an After hook failed after its steps passed" })], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false })).toEqual({
      verdict: "moved",
      reason: "passes in default, but the mapping changed since the base, and in the old world in default, an After hook failed after its steps passed",
    });
    expect(judgeRow([head, at("old", "not-run", { runs: 0, reason: "its step files did not load" })], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false })).toEqual({
      verdict: "moved",
      reason: "passes in default, but the mapping changed since the base, and it did not run in the old world in default: its step files did not load",
    });
    const onIn = (environment: string): RunTableCell => ({ ...head, environment });
    const notRunIn = (environment: string, reason: string): RunTableCell => at("old", "not-run", { environment, runs: 0, reason });
    expect(
      judgeRow([onIn("on"), onIn("off"), notRunIn("on", "the config file did not load"), notRunIn("off", "the config file did not load")], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false }),
    ).toEqual({
      verdict: "moved",
      reason: "passes in on, off, but the mapping changed since the base, and it did not run in the old world in on, off: the config file did not load",
    });
    expect(
      judgeRow([onIn("on"), onIn("off"), notRunIn("on", "the config file did not load"), notRunIn("off", "its step files did not load")], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false }).reason,
    ).toBe("passes in on, off, but the mapping changed since the base, and it did not run in the old world in on: the config file did not load");
    expect(judgeRow([head, at("old", "fail", { line: 6, runs: 1, claim: 0, actuals: [] })], 2, { change: "unchanged", held: false, mappingChanged: false, retagged: true, renamed: false })).toEqual({
      verdict: "moved",
      reason: "passes in default, but its tags changed since the base, and a claim broke at line 6 of the base's feature file in the old world in default",
    });
    expect(judgeRow([head], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: true, renamed: false })).toEqual({
      verdict: "moved",
      reason: "passes in default, but the mapping and its tags changed since the base and the old world did not run it",
    });
    expect(judgeRow([head, at("old", "fail", { line: 6, runs: 1, claim: 0, actuals: [] })], 2, { change: "unchanged", held: false, mappingChanged: false, retagged: false, renamed: true })).toEqual({
      verdict: "moved",
      reason: "passes in default, but its name or its file changed since the base, and a claim broke at line 6 of the base's feature file in the old world in default",
    });
    const control: RunTableCell = { world: "head", environment: "off", role: "control", conditions: {}, outcome: "fail", line: 8, runs: 2, claim: 0, actuals: [] };
    expect(judgeRow([head, control], 2, { change: "unchanged", held: false, mappingChanged: false, retagged: false, renamed: false })).toEqual({
      verdict: "proven",
      reason: "passes in default, and a claim broke at line 8 in off, where its conditions do not hold, in each of 2 runs",
    });
    expect(judgeRow([head, control, at("old", "pass")], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false })).toEqual({
      verdict: "proven",
      reason: "passes in default, and a claim broke at line 8 in off, where its conditions do not hold, in each of 2 runs, and it passed in the old world, where the base's mapping runs head's code",
    });
    expect(judgeRow([head, control, at("old", "broke", { line: 4 })], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: false, renamed: false }).verdict).toBe("moved");
    expect(judgeRow([head], 2, { change: "unchanged", held: false, mappingChanged: true, retagged: true, renamed: true })).toEqual({
      verdict: "moved",
      reason: "passes in default, but the mapping, its tags, and its name or its file changed since the base and the old world did not run it",
    });
    expect(judgeRow([head, at("base", "fail", { line: 9, runs: 2 })], 2, { change: "changed", held: false, mappingChanged: false, retagged: false, renamed: false })).toEqual({
      verdict: "proven",
      reason: "passes in default, and a claim broke at line 9 at the base in default in each of 2 runs",
    });
    expect(judgeRow([head, at("base", "fail", { line: 9, runs: 2 })], 2, { change: "new", held: true, mappingChanged: false, retagged: false, renamed: false })).toEqual({
      verdict: "proven",
      reason: "passes in default, and a claim broke at line 9 at the base in default in each of 2 runs, so the base does not have this behaviour and @held is not needed",
    });
    expect(judgeRow([head, at("base", "pass")], 2, { change: "new", held: true, mappingChanged: false, retagged: false, renamed: false })).toEqual({
      verdict: "held",
      reason: "passes in default and at the base, as @held says",
    });
    expect(judgeRow([head, at("base", "broke", { line: 7 })], 2, { change: "new", held: true, mappingChanged: false, retagged: false, renamed: false })).toEqual({
      verdict: "unproven",
      reason: "passes in default, and @held says the base has this behaviour, but it stopped at line 7 at the base in default before a claim there was judged",
    });
    expect(judgeRow([head, at("base", "fail", { line: 9, runs: 1 })], 2, { change: "new", held: false, mappingChanged: false, retagged: false, renamed: false })).toEqual({
      verdict: "unproven",
      reason: "passes in default, and nothing shows a Then failing where its behaviour is absent (base default: fail@9)",
    });
    expect(judgeRow([head], 2, { change: "new", held: false, mappingChanged: false, retagged: false, renamed: false })).toEqual({
      verdict: "unproven",
      reason: "passes in default, and no world where its behaviour is absent ran it, so nothing shows a Then failing without the change",
    });
    expect(judgeRow([head, at("base", "broke", { line: 5 })], 2, { change: "new", held: false, mappingChanged: false, retagged: false, renamed: false, thenJudgesNoClaim: "compat" })).toEqual({
      verdict: "unproven",
      reason: "passes in default, but its Then is a compat step, which judges no claim, so no world can show a Then failing where its behaviour is absent (base default: broke@5)",
    });
    expect(judgeRow([head], 2, { change: "changed", held: false, mappingChanged: false, retagged: false, renamed: false, thenJudgesNoClaim: "nothing" })).toEqual({
      verdict: "unproven",
      reason: "passes in default, but no claim step stands in its Then position, so no world can show a Then failing where its behaviour is absent",
    });
    // @held still holds a row the base passes, whatever its Then is.
    expect(judgeRow([head, at("base", "pass")], 2, { change: "new", held: true, mappingChanged: false, retagged: false, renamed: false, thenJudgesNoClaim: "compat" }).verdict).toBe("held");
  });
});

describe("judgedRowFindings", () => {
  const verdict = gs.sampledFrom<RunRowVerdict>(["held", "proven", "removed", "failed", "unproven", "moved"]);

  it("gives one failed finding per unproven or moved row, whose do: line judges that row again against the same base", () =>
    hegel.test((tc) => {
      const verdicts = tc.draw(gs.arrays(verdict, { maxSize: 6 }));
      const rows = verdicts.map((word, index) => ({ feature: "features/a b.feature", line: index + 3, name: `row ${index}`, verdict: word, reason: "passes in default, and more", cells: [] }));
      const findings = judgedRowFindings({ rows } as unknown as Parameters<typeof judgedRowFindings>[0], "origin/main", ["--env", "on"]);
      const red = rows.filter((row) => row.verdict === "unproven" || row.verdict === "moved");
      expect(findings.map((finding) => [finding.severity, finding.code, finding.line])).toEqual(red.map((row) => ["failed", `criterion-${row.verdict}`, row.line]));
      for (const [index, finding] of findings.entries()) {
        expect(finding.message).toBe(`Scenario "${red[index]!.name}" is ${red[index]!.verdict}: it passes in default, and more`);
        expect(finding.do).toBe(`nuka run 'features/a b.feature:${red[index]!.line}' --base origin/main --env on`);
      }
    }));

  it("runs a row without --base, and gives the obstacle's edit, where an obstacle kept the world its verdict reads from being built", () =>
    hegel.test((tc) => {
      const verdicts = tc.draw(gs.arrays(gs.sampledFrom<RunRowVerdict>(["unproven", "moved"]), { minSize: 1, maxSize: 4 }));
      const blocked = tc.draw(gs.arrays(gs.sampledFrom(["base", "old"] as const), { maxSize: 2 }));
      const obstacles = [...new Set(blocked)].map((world) => ({ world, fix: `replace the link in the ${world} world` }));
      const rows = verdicts.map((word, index) => ({ feature: "features/a.feature", line: index + 3, name: `row ${index}`, verdict: word, reason: "passes in default", cells: [] }));
      const findings = judgedRowFindings({ rows } as unknown as Parameters<typeof judgedRowFindings>[0], "origin/main", [], obstacles);
      for (const [index, finding] of findings.entries()) {
        const world = rows[index]!.verdict === "unproven" ? "base" : "old";
        const obstacle = obstacles.find((entry) => entry.world === world);
        expect(finding.do).toBe(obstacle === undefined ? `nuka run features/a.feature:${index + 3} --base origin/main` : `nuka run features/a.feature:${index + 3}`);
        expect(finding.fix).toBe(obstacle?.fix);
      }
    }));

  it("leaves a removed row, which has no cells, out of the rows without a required cell", () => {
    const rows = [{ feature: "f.feature", line: 3, name: "gone", change: "removed", conditions: [], cells: [], verdict: "removed", reason: "", lines: [] }];
    expect(rowsWithoutRequiredCell({ rows } as unknown as Parameters<typeof rowsWithoutRequiredCell>[0], [{ name: "default", conditions: undefined }], () => undefined)).toEqual([]);
  });
});
