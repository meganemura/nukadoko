import { createHash } from "node:crypto";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { recordDisagrees } from "../src/cli/judge.js";
import type { RunClaim, RunScenario, RunStep, RunTable, RunTableCell, RunTableRow } from "../src/record/run-result.js";
import {
  addJudgment,
  canonicalJson,
  judgmentFileText,
  judgmentFindings,
  judgmentsOpen,
  parseJudgmentFile,
  readAgainst,
  valueDigest,
  withJudgments,
  type JudgedValue,
  type JudgmentEntry,
} from "../src/run/judgments.js";

// Responsibility: the pure core of judgments (src/run/judgments.ts). The
// properties are the promises the spec makes: a value's digest does not
// depend on key order, a judgment decides a value exactly when its digest
// is the value's, a value whose claim has only judgments of other values
// is stale, the machine verdict is never changed by a judgment, a file
// reads back the entries it was written with, and a step record agrees
// with run.json exactly when the digests match. Example tests pin the
// findings' exact text.

/** Any plain JSON value, nested a little. */
function drawJson(tc: hegel.TestCase, depth = 0): unknown {
  const kind = tc.draw(gs.integers({ minValue: 0, maxValue: depth >= 2 ? 3 : 5 }));
  switch (kind) {
    case 0:
      return null;
    case 1:
      return tc.draw(gs.booleans());
    case 2:
      return tc.draw(gs.integers({ minValue: -50, maxValue: 50 }));
    case 3:
      return tc.draw(gs.text({ maxSize: 6, alphabet: "ab\"\\é\n " }));
    case 4:
      return tc.draw(gs.arrays(gs.just(0), { maxSize: 3 })).map(() => drawJson(tc, depth + 1));
    default: {
      const keys = tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 3, alphabet: "abc" }), { maxSize: 3, unique: true }));
      return Object.fromEntries(keys.map((key) => [key, drawJson(tc, depth + 1)]));
    }
  }
}

/** `value` with every object's keys in another order. */
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reordered(inner)]));
  return value;
}

const CRITERION = "a first-time visitor is greeted";
const THEN = 'the greeting reads as "friendly"';

function judged(value: unknown, measured: string | null = "observed.processes[0].stdout of step-1"): JudgedValue {
  return {
    line: 6,
    step: THEN,
    claim: 0,
    environment: "default",
    quality: '"friendly"',
    value_from: "from:run-greet@4.stdout as text",
    value_digest: valueDigest(value),
    measured,
    record: "steps/step-2",
    value,
  };
}

function entry(value: unknown, verdict: "meets" | "misses" = "meets", at = "2026-11-03T12:00:00.000Z", extra: Partial<JudgmentEntry> = {}): JudgmentEntry {
  return {
    criterion: CRITERION,
    then: THEN,
    claim: 0,
    quality: '"friendly"',
    value_digest: valueDigest(value),
    value,
    verdict,
    because: "It welcomes the visitor.",
    by: "reviewer",
    run_id: "run-20261103-120000-abcd",
    commit: null,
    at,
    ...extra,
  };
}

describe("the digest a judgment cites", () => {
  it("does not depend on the order an object's keys were written in", () =>
    hegel.test((tc) => {
      const value = drawJson(tc);
      expect(valueDigest(reordered(value))).toBe(valueDigest(value));
    }));

  it("differs for two values whose canonical JSON differs", () =>
    hegel.test((tc) => {
      const a = drawJson(tc);
      const b = drawJson(tc);
      expect(valueDigest(a) === valueDigest(b)).toBe(canonicalJson(a) === canonicalJson(b));
    }));

  it("is sha256 over the canonical JSON", () => {
    expect(canonicalJson({ b: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"b":1}');
    expect(valueDigest({ b: 1, a: [true, "x"] })).toBe(`sha256:${createHash("sha256").update('{"a":[true,"x"],"b":1}').digest("hex")}`);
  });
});

describe("a value read against the judgments", () => {
  it("is judged or misses exactly when an entry of its claim cites its digest, stale when entries cite only other values, and pending with none", () =>
    hegel.test((tc) => {
      const value = drawJson(tc);
      const others = tc.draw(gs.arrays(gs.just(0), { maxSize: 3 })).map(() => drawJson(tc));
      const verdicts = others.map(() => tc.draw(gs.sampledFrom(["meets", "misses"] as const)));
      const entries = others.map((other, index) => entry(other, verdicts[index]!, `2026-11-03T12:00:0${index}.000Z`));
      const read = readAgainst(judged(value), CRITERION, entries);
      const match = entries.find((candidate) => candidate.value_digest === valueDigest(value));
      if (match !== undefined) expect(read.state).toBe(match.verdict === "meets" ? "judged" : "misses");
      else if (entries.length > 0) {
        expect(read.state).toBe("stale");
        // The latest judgment of the claim is the one that went stale.
        expect(read.judgment?.value_digest).toBe(entries.at(-1)!.value_digest);
      } else expect(read.state).toBe("pending");
    }));

  it("is uncitable when no recorded channel holds it, whatever a file says", () =>
    hegel.test((tc) => {
      const value = drawJson(tc);
      const read = readAgainst(judged(value, null), CRITERION, tc.draw(gs.booleans()) ? [entry(value)] : []);
      expect(read.state).toBe("uncitable");
      expect(read.judgment).toBeUndefined();
    }));

  it("reads only the judgments of its own criterion, Then, and claim", () => {
    const value = "Welcome!";
    for (const other of [{ criterion: "another" }, { then: "another line" }, { claim: 1 }]) {
      expect(readAgainst(judged(value), CRITERION, [entry(value, "meets", undefined, other)]).state).toBe("pending");
    }
  });

  it("names where a stale value first differs from the judged one", () => {
    const read = readAgainst(judged("line one\nline two"), CRITERION, [entry("line one\nline 2")]);
    expect(read).toMatchObject({ state: "stale", judgment: { value: "line one\nline 2", difference: 'first difference at line 2: actual "line two", expected "line 2"' } });
  });
});

function claim(actual: unknown, measured: RunClaim["measured"] = { step_record_id: "step-1", channel: "observed.processes[0].stdout" }): RunClaim {
  return {
    actual,
    actual_from: "from:run-greet@4.stdout as text",
    view: "text",
    compare: "judged-as",
    expected: '"friendly"',
    expected_from: "sentence:quality",
    expected_text: '"friendly"',
    outcome: "for-judgment",
    measured,
    value_digest: valueDigest(actual),
  };
}

function step(claims: readonly RunClaim[]): RunStep {
  return { line: 6, text: THEN, step: "greeting-reads-as", status: "passed", step_record_id: "step-2", record: "steps/step-2", claims };
}

function scenario(environment: string, steps: readonly RunStep[], extra: Partial<RunScenario> = {}): RunScenario {
  return {
    scenario_record_id: `scn-${environment}`,
    feature: "features/greeting.feature",
    line: 3,
    scenario: CRITERION,
    environment,
    status: "passed",
    started_at: "2026-11-03T12:00:00.000Z",
    finished_at: "2026-11-03T12:00:01.000Z",
    steps,
    hooks: [],
    ...extra,
  };
}

function cell(environment: string, outcome: RunTableCell["outcome"], role: RunTableCell["role"] = "required"): RunTableCell {
  return { world: "head", environment, role, conditions: {}, outcome, runs: 1, ...(outcome === "pass" || outcome === "not-run" ? {} : { line: 6 }) };
}

function table(rows: readonly RunTableRow[]): RunTable {
  return { base: null, mapping_changed: null, mapping_changes: null, worlds: [{ world: "head", environment: "default" }], rows, left_out: 0, proof_runs: 2 };
}

function row(verdict: RunTableRow["verdict"], cells: readonly RunTableCell[]): RunTableRow {
  return { feature: "features/greeting.feature", line: 3, name: CRITERION, change: null, conditions: [], cells, verdict, reason: "passes in default" };
}

describe("the table with judgments", () => {
  it("never changes a row's verdict, reason, or cells, and gives a judgment only to a row whose required head cells passed", () =>
    hegel.test((tc) => {
      const environments = tc.draw(gs.sampledFrom([["default"], ["on", "off"]]));
      const cells = environments.map((environment) => cell(environment, tc.draw(gs.sampledFrom(["pass", "pass", "fail", "broke", "not-run"] as const)), tc.draw(gs.sampledFrom(["required", "control"] as const))));
      const verdict = tc.draw(gs.sampledFrom(["held", "proven", "failed", "unproven", "moved"] as const));
      const values = environments.map(() => tc.draw(gs.sampledFrom(["Welcome!", "Hello.", "Go away."])));
      const scenarios = environments.map((environment, index) => scenario(environment, [step([claim(values[index], tc.draw(gs.booleans()) ? null : undefined)])]));
      const entries = tc.draw(gs.arrays(gs.sampledFrom(["Welcome!", "Hello.", "Go away."]), { maxSize: 2 })).map((value) => entry(value, tc.draw(gs.sampledFrom(["meets", "misses"] as const))));
      const before = table([row(verdict, cells)]);
      const after = withJudgments(before, scenarios, () => entries);
      const [was, is] = [before.rows[0]!, after.rows[0]!];
      expect({ verdict: is.verdict, reason: is.reason, cells: is.cells }).toEqual({ verdict: was.verdict, reason: was.reason, cells: was.cells });
      const required = cells.filter((entryCell) => entryCell.role === "required");
      const passed = required.length > 0 && required.every((entryCell) => entryCell.outcome === "pass");
      expect(is.judgment !== undefined).toBe(passed);
      // The gate opens on the judgment alone, never on the verdict.
      if (is.judgment !== undefined) expect(judgmentsOpen(after)).toBe(is.judgment.state !== "judged");
    }));

  it("reads one value once whatever environments read it, and decides the row by its worst value", () => {
    const scenarios = [scenario("on", [step([claim("Welcome!")])]), scenario("off", [step([claim("Welcome!")])]), scenario("eu", [step([claim("Willkommen!")])])];
    const judgedTable = withJudgments(table([row("held", [cell("on", "pass"), cell("off", "pass"), cell("eu", "pass")])]), scenarios, () => [entry("Welcome!")]);
    const judgment = judgedTable.rows[0]!.judgment!;
    expect(judgment.reads.map((read) => [read.environment, read.state])).toEqual([
      ["on", "judged"],
      ["eu", "pending"],
    ]);
    expect(judgment.state).toBe("pending");
    expect(judgment.reason).toBe('line 6 read "Willkommen!" for a judgment as "friendly", and no judgment cites it');
  });

  it("leaves a control's value, and a value no claim read for a judgment, out", () => {
    const held = { ...claim("Welcome!"), outcome: "held" as const, compare: "equal" as const };
    const scenarios = [scenario("default", [step([held])]), scenario("off", [step([claim("Hello.")])], { role: "control" })];
    expect(withJudgments(table([row("held", [cell("default", "pass"), cell("off", "pass", "control")])]), scenarios, () => []).rows[0]!.judgment).toBeUndefined();
  });

  it("gives each open row one finding with what closes it", () => {
    const rows = (["pending", "misses", "uncitable"] as const).map((kind, index): RunTableRow => {
      const value = ["Welcome!", "Go away.", "computed"][index]!;
      const scenarios = [scenario("default", [step([claim(value, kind === "uncitable" ? null : undefined)])])];
      return withJudgments(table([row("held", [cell("default", "pass")])]), scenarios, () => (kind === "misses" ? [entry(value, "misses")] : [])).rows[0]!;
    });
    expect(judgmentFindings(table(rows), "run-20261103-120000-abcd")).toEqual([
      {
        severity: "failed",
        code: "judgment-pending",
        file: "features/greeting.feature",
        line: 3,
        message: `Scenario "${CRITERION}" line 6 read "Welcome!" for a judgment as "friendly", and no judgment cites it`,
        fix: "a judge who did not write the change reads the value against the sentence, then records it with nuka judge and --meets or --misses, --by, and --because",
        do: "nuka judge features/greeting.feature:3 --run run-20261103-120000-abcd",
      },
      {
        severity: "failed",
        code: "judgment-misses",
        file: "features/greeting.feature",
        line: 3,
        message: `Scenario "${CRITERION}" reviewer judged the value line 6 read, "Go away.", not "friendly": It welcomes the visitor.`,
        fix: "change the program until the value meets the sentence, then run it again and have it judged again",
        do: "nuka judge features/greeting.feature:3 --run run-20261103-120000-abcd",
      },
      {
        severity: "failed",
        code: "judgment-uncitable",
        file: "features/greeting.feature",
        line: 3,
        message: `Scenario "${CRITERION}" line 6 asks for a judgment of from:run-greet@4.stdout as text, which no channel of a step record holds, so no judgment can cite it`,
        fix: "read the value whole from a channel the step record holds (a response, a process's output, a file) and narrow it with view and at, or return the locator or page from observe so nukadoko takes its ARIA snapshot",
      },
    ]);
  });
});

describe("a judgment file", () => {
  it("reads back the entries it was written with, in the order it writes them", () =>
    hegel.test((tc) => {
      const entries = tc.draw(gs.arrays(gs.just(0), { maxSize: 4 })).map((_, index) =>
        entry(drawJson(tc), tc.draw(gs.sampledFrom(["meets", "misses"] as const)), `2026-11-03T12:00:0${index}.000Z`, {
          criterion: tc.draw(gs.sampledFrom(["a", "b"])),
          claim: tc.draw(gs.integers({ minValue: 0, maxValue: 1 })),
        }),
      );
      const text = judgmentFileText(entries);
      const read = parseJudgmentFile(text);
      expect("entries" in read).toBe(true);
      if (!("entries" in read)) return;
      expect(read.entries).toHaveLength(entries.length);
      expect(judgmentFileText(read.entries)).toBe(text);
    }));

  it("keeps one entry per value of a claim: judging a value again replaces it, and another value is added beside it", () =>
    hegel.test((tc) => {
      const values = tc.draw(gs.arrays(gs.sampledFrom(["a", "b", "c"]), { maxSize: 6 }));
      let entries: JudgmentEntry[] = [];
      for (const [index, value] of values.entries()) entries = addJudgment(entries, entry(value, "meets", `2026-11-03T12:00:0${index}.000Z`));
      expect(entries.map((each) => each.value).sort()).toEqual([...new Set(values)].sort());
      // A value judged before is still found when it comes back.
      for (const value of values) expect(readAgainst(judged(value), CRITERION, entries).state).toBe("judged");
    }));

  it("says why a file holds no judgments rather than reading it as empty", () => {
    expect(parseJudgmentFile("{")).toMatchObject({ problem: expect.stringContaining("it is not JSON") });
    expect(parseJudgmentFile("{}")).toEqual({ problem: "it holds no judgments array" });
    expect(parseJudgmentFile(JSON.stringify({ judgments: [{ ...entry("x"), verdict: "maybe" }] }))).toEqual({ problem: "judgments[0] needs a claim number and a verdict of meets or misses" });
    expect(parseJudgmentFile(JSON.stringify({ judgments: [{ ...entry("x"), by: 3 }] }))).toEqual({ problem: "judgments[0] has no text by" });
  });
});

describe("a step record against run.json", () => {
  it("agrees exactly when the value it holds has the digest run.json recorded", () =>
    hegel.test((tc) => {
      const recorded = drawJson(tc);
      const held = tc.draw(gs.booleans()) ? recorded : drawJson(tc);
      const problem = recordDisagrees({ record: "steps/step-2", claim: 0, value_digest: valueDigest(recorded) }, { claims: [{ actual: held, outcome: "for-judgment" }] });
      expect(problem === null).toBe(valueDigest(held) === valueDigest(recorded));
    }));

  it("names a record that holds no value, or a claim that was not read for a judgment", () => {
    const read = { record: "steps/step-2", claim: 0, value_digest: valueDigest("x") };
    expect(recordDisagrees(read, { claims: [] })).toBe("steps/step-2 holds no value for claim 0");
    expect(recordDisagrees(read, { claims: [{ actual: "x", outcome: "held" }] })).toBe("steps/step-2 records claim 0 as held, not for-judgment");
  });
});
