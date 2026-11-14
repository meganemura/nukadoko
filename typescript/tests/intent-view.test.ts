import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import type { RunPathComparison, RunPathCriterion, RunPathDifference, RunScenario } from "../src/record/run-result.js";
import { parseIntent, intentTable } from "../src/run/intent.js";
import { intentFindings, judgeIntent } from "../src/run/intent-view.js";

// Responsibility: what each row of an intent came to against run.json's
// base pairs (src/run/intent-view.ts): the row that declares each
// difference, each criterion's account read again, and each row's result,
// on the entitlement change whose planted mistakes docs/intent.md uses,
// and as invariants over generated rows and differences.

const FEATURE = "features/entitlements.feature";

/** A decision entry of a step's path, keyed as the team intent's fields
 * make it. */
function decision(plan: string, seats: number, features: readonly string[]): Record<string, unknown> {
  return { kind: "x_decision", "x_result.features": features, "x_result.reason": `plan:${plan}`, "x_result.seats": seats };
}

interface Side {
  readonly entries: readonly Record<string, unknown>[];
}

/** One criterion whose one step held `a` at the base and `b` at head, with
 * the scenarios its sides name and the comparison path-view would make. */
function criterion(line: number, name: string, change: "unchanged" | "new", a: Side, b: Side): { readonly criterion: RunPathCriterion; readonly scenarios: RunScenario[] } {
  const text = (entry: Record<string, unknown>): string => JSON.stringify(entry);
  const changed: RunPathDifference[] = [];
  for (const key of new Set([...a.entries, ...b.entries].map(text))) {
    const [inA, inB] = [a.entries.filter((entry) => text(entry) === key).length, b.entries.filter((entry) => text(entry) === key).length];
    if (inA !== inB) changed.push({ ...(JSON.parse(key) as object), a: { at_least: inA, at_most: inA }, b: { at_least: inB, at_most: inB } } as unknown as RunPathDifference);
  }
  const scenario = (id: string, side: Side): RunScenario =>
    ({ scenario_record_id: id, steps: [{ line: line + 1, text: "a step", path: { requests: [], entries: side.entries.map((entry) => ({ ...entry, count: 1 })), maybe: 0, open: [] } }] }) as unknown as RunScenario;
  return {
    criterion: {
      feature: FEATURE,
      line,
      name,
      result: changed.length > 0 ? "changed" : "same",
      ...(changed.length > 0 ? { explained_by: change === "new" ? "criterion_change" : null } : {}),
      a: { scenario_record_id: `a${line}`, outcome: "pass" },
      b: { scenario_record_id: `b${line}`, outcome: "pass" },
      ...(changed.length > 0 ? { steps: [{ line: line + 1, text: "a step", ran: "both", changed, open: [], gaps: { a: [], b: [] } }] } : {}),
    } as RunPathCriterion,
    scenarios: [scenario(`a${line}`, a), scenario(`b${line}`, b)],
  };
}

function basePair(criteria: readonly RunPathCriterion[]): RunPathComparison {
  return {
    between: { kind: "base" },
    a: { world: "base", environment: "default" },
    b: { world: "head", environment: "default" },
    unread: null,
    counts: { changed: 0, open: 0, same_so_far: 0, marked_only: 0, same: 0, not_compared: 0 },
    criteria,
    not_compared: [],
  };
}

const TEAM = parseIntent(
  intentTable([{ target: "x_result.reason=plan:team x_result.seats>=10", observation: "x_decision x_result.features", before: '["projects","sso"]', after: '["projects","sso","audit_log"]' }]),
);

describe("judgeIntent on the team audit log change", () => {
  const made = [
    criterion(3, "a small team", "unchanged", { entries: [decision("team", 5, ["projects", "sso"])] }, { entries: [decision("team", 5, ["projects", "sso"])] }),
    criterion(7, "a team of 10", "unchanged", { entries: [decision("team", 10, ["projects", "sso"])] }, { entries: [decision("team", 10, ["projects", "sso"])] }),
    criterion(11, "a team of 12", "unchanged", { entries: [decision("team", 12, ["projects", "sso"])] }, { entries: [decision("team", 12, ["projects", "sso", "audit_log"])] }),
    criterion(15, "a starter of 12", "unchanged", { entries: [decision("starter", 3, ["projects"])] }, { entries: [decision("starter", 3, ["projects", "audit_log"])] }),
  ];
  const table = { rows: made.map(({ criterion: entry }) => ({ feature: entry.feature, line: entry.line, change: "unchanged" as const })) };
  const judged = judgeIntent(TEAM, [basePair(made.map((entry) => entry.criterion))], made.flatMap((entry) => entry.scenarios), table, () => []);

  it("declares the team of 12's change with row 1, and leaves the starter's undeclared", () => {
    const criteria = judged.paths[0]!.criteria;
    expect(criteria.map((entry) => [entry.line, entry.result, entry.explained_by])).toEqual([
      [3, "same", undefined],
      [7, "same", undefined],
      [11, "changed", "intent"],
      [15, "changed", null],
    ]);
    const intents = (line: number): (number | undefined)[] => {
      const [step] = criteria.find((entry) => entry.line === line)!.steps!;
      return step!.ran === "both" ? step!.changed.map((difference) => difference.intent) : [];
    };
    expect(intents(11)).toEqual([1, 1]);
    expect(intents(15)).toEqual([undefined, undefined]);
  });

  it("says the row did not happen for the team of 10 and did for the team of 12", () => {
    expect(judged.rows).toEqual([
      {
        row: 1,
        result: "not_happening",
        as_intended: [{ feature: FEATURE, line: 11 }],
        not_happening: [{ feature: FEATURE, line: 7 }],
      },
    ]);
  });

  it("gates on the undeclared difference and on the row that did not happen", () => {
    const record = {
      file: "INTENT.md",
      declared_in: null,
      changed_after: [],
      uncommitted: true,
      problems: [],
      rows: [{ ...judged.rows[0]!, line: 7, target: "", observation: "", before: "", after: "" }],
    };
    expect(intentFindings(record, judged.paths, (place) => ["nuka", "run", `${place.feature}:${place.line}`, "--base", "main"])).toEqual([
      {
        severity: "failed",
        code: "intent-unintended",
        file: FEATURE,
        line: 15,
        message: 'Scenario "a starter of 12" did something at head that it did not do at the base, and neither INTENT.md nor its sentences declare it; "base → head" in the summary lists what',
        fix: "Declare the difference with a row in INTENT.md if the change means it, or change the code back if it does not.",
        do: "nuka run features/entitlements.feature:15 --base main",
      },
      {
        severity: "failed",
        code: "intent-not-happening",
        file: "INTENT.md",
        line: 7,
        message: "row 1 of INTENT.md did not happen in features/entitlements.feature:7, which its target names",
        fix: "Make the change do what the row says there, or narrow the row's target if the row means less.",
        do: "nuka run features/entitlements.feature:7 --base main",
      },
    ]);
  });

  it("finds a value that went somewhere other than the row says undeclared", () => {
    const other = criterion(11, "a team of 12", "unchanged", { entries: [decision("team", 12, ["projects", "sso"])] }, { entries: [decision("team", 12, ["projects"])] });
    const again = judgeIntent(TEAM, [basePair([other.criterion])], other.scenarios, { rows: [{ feature: FEATURE, line: 11, change: "unchanged" }] }, () => []);
    expect(again.paths[0]!.criteria[0]!.explained_by).toBe(null);
    expect(again.rows[0]!.result).toBe("not_happening");
  });
});

describe("judgeIntent over generated rows and counts", () => {
  // Rows on one outgoing call, each aimed by tags; criteria whose one step
  // made that call some number of times at the base and at head.
  const call = { kind: "http", method: "POST", origin: "http://billing", path: "/usage_records", status: 201 };
  const tagSet = gs.arrays(gs.sampledFrom(["@a", "@b"]), { maxSize: 2 }).map((tags) => [...new Set(tags)]);
  const rowCells = gs.tuples(tagSet, gs.oneOf(gs.tuples(gs.integers({ minValue: 0, maxValue: 2 }), gs.integers({ minValue: 0, maxValue: 2 })).filter(([a, b]) => a !== b), gs.just(null))).map(([tags, change]) => ({
    target: tags.join(" "),
    observation: "http method=POST path=/usage_records",
    before: change === null ? "" : String(change[0]),
    after: change === null ? "" : String(change[1]),
  }));
  const criteriaOf = gs.arrays(gs.tuples(tagSet, gs.integers({ minValue: 0, maxValue: 2 }), gs.integers({ minValue: 0, maxValue: 2 })), { minSize: 1, maxSize: 4 });

  it("declares a difference only by a row aimed at it that names its two counts, and accounts for a criterion by the intent only when every difference is declared", () =>
    hegel.test((tc) => {
      const intent = parseIntent(intentTable(tc.draw(gs.arrays(rowCells, { maxSize: 3 }))));
      expect(intent.problems).toEqual([]);
      const drawn = tc.draw(criteriaOf);
      const made = drawn.map(([, a, b], index) => criterion(index * 10 + 1, `c${index}`, "unchanged", { entries: Array(a).fill(call) }, { entries: Array(b).fill(call) }));
      const tagsOf = (place: { readonly line: number }): string[] => drawn[(place.line - 1) / 10]![0];
      const table = { rows: made.map(({ criterion: entry }) => ({ feature: entry.feature, line: entry.line, change: "unchanged" as const })) };
      const judged = judgeIntent(intent, [basePair(made.map((entry) => entry.criterion))], made.flatMap((entry) => entry.scenarios), table, tagsOf);
      judged.paths[0]!.criteria.forEach((entry, index) => {
        const [tags, a, b] = drawn[index]!;
        const differences = (entry.steps ?? []).flatMap((step) => (step.ran === "both" ? step.changed : []));
        const aimed = intent.rows.filter((row) => row.tags.every((tag) => tags.includes(tag)));
        const declaring = aimed.find((row) => row.change !== null && row.change.before === a && row.change.after === b);
        for (const difference of differences) expect(difference.intent).toBe(declaring?.row);
        if (entry.result === "changed") expect(entry.explained_by).toBe(declaring === undefined ? null : "intent");
        for (const row of intent.rows) {
          const result = judged.rows[row.row - 1]!;
          const place = { feature: FEATURE, line: entry.line };
          const listed = [result.as_intended, result.not_happening].filter((list) => list.some((at) => at.line === place.line)).length;
          expect(listed).toBe(aimed.includes(row) ? 1 : 0);
          if (aimed.includes(row)) {
            const did = row.change === null ? a === b || declaring !== undefined : declaring === row;
            expect(result.as_intended.some((at) => at.line === place.line)).toBe(did);
          }
        }
      });
      for (const result of judged.rows) {
        expect(result.result).toBe(result.not_happening.length > 0 ? "not_happening" : result.as_intended.length > 0 ? "as_intended" : "not_reached");
      }
    }));
});
