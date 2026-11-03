import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import type { RunDocument, RunLimit, RunScenario, RunStep, RunTableCell, RunTableRow, RunWorld } from "../src/record/run-result.js";
import { writeLimitCounts } from "../src/run/progress-log.js";
import { LIMIT_KINDS, limitsOf } from "../src/run/run-limits.js";
import { renderRunSummary } from "../src/run/run-summary.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: run.json's `limits` and the summary section that lists
// them. Example tests pin the exact entries and lines of each kind that
// none of the older summary tests reach: a held row whose control broke
// before its Then or passed, a scenario no claim judged that has a
// control, and the stderr line. The properties are over any run document
// the record types allow: the list never throws, every entry names a
// criterion, a step, or a world the document holds, the kinds come in the
// summary's order, and the summary lists every entry the list holds,
// whatever a stored `limits` says.

const base: RunDocument = {
  schema_version: 4,
  nukadoko: "0.25.0",
  command: "run",
  verdict: "passed",
  findings: [],
  run_id: "run-20261103-120000-abcd",
  started_at: "2026-11-03T12:00:00.000Z",
  finished_at: "2026-11-03T12:00:05.000Z",
  commit: { sha: "0123456789abcdef0123456789abcdef01234567", dirty: false },
  environments: [{ name: "default", target_version: null }],
  selection: "full",
  counts: { scenarios: 0, passed: 0, failed: 0, not_run: 0, controls: 0, controls_not_run: 0 },
  scenarios: [],
  table: { base: null, mapping_changed: null, mapping_changes: null, worlds: [{ world: "head", environment: "default" }], rows: [], left_out: 0, proof_runs: 2 },
};

function cell(environment: string, role: RunTableCell["role"], outcome: RunTableCell["outcome"], line?: number): RunTableCell {
  return { world: "head", environment, role, conditions: {}, outcome, runs: 1, ...(line === undefined ? {} : { line }) };
}

function row(line: number, verdict: RunTableRow["verdict"], cells: readonly RunTableCell[]): RunTableRow {
  return { feature: "features/orders.feature", line, name: `criterion ${line}`, change: null, conditions: ["@with:quick_reorder"], cells, verdict, reason: "passes in reorder-on" };
}

function execution(line: number, environment: string, role: "required" | "control", status: RunScenario["status"], steps: readonly RunStep[], extra: Partial<RunScenario> = {}): RunScenario {
  return {
    scenario_record_id: `scn-${line}-${environment}`,
    feature: "features/orders.feature",
    line,
    scenario: `criterion ${line}`,
    environment,
    role,
    status,
    started_at: base.started_at,
    finished_at: base.finished_at,
    steps,
    hooks: [],
    ...extra,
  };
}

function step(line: number, status: RunStep["status"], record: string | null, extra: Partial<RunStep> = {}): RunStep {
  return { line, text: `step ${line}`, step: "a-step", status, step_record_id: null, record, ...extra };
}

// The list under "What this run does not show", up to the blank line
// after it.
function limitsSection(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf("## What this run does not show");
  return start === -1 ? [] : lines.slice(start + 4, lines.indexOf("", start + 4));
}

const twoEnvironments: Partial<RunDocument> = {
  environments: [
    { name: "reorder-on", target_version: null, conditions: { quick_reorder: true } },
    { name: "reorder-off", target_version: null, conditions: { quick_reorder: false } },
  ],
};

describe("limitsOf and the summary's What this run does not show", () => {
  it("names a held row whose control broke before its Then, with the record where it broke, and one whose control passed", () => {
    const document: RunDocument = {
      ...base,
      ...twoEnvironments,
      scenarios: [
        execution(3, "reorder-on", "required", "passed", [step(4, "passed", "steps/a"), step(5, "passed", "steps/b")]),
        // Its Then never ran, so this execution judged no claim, which is
        // the control's entry and not the scenario's: the required one did.
        execution(3, "reorder-off", "control", "failed", [step(4, "failed", "steps/c"), step(5, "skipped", null)], { judged_by: "nothing" }),
        execution(8, "reorder-on", "required", "passed", [step(9, "passed", "steps/d")]),
        execution(8, "reorder-off", "control", "passed", [step(9, "passed", "steps/e")]),
      ],
      table: {
        ...base.table,
        rows: [
          row(3, "held", [cell("reorder-on", "required", "pass"), cell("reorder-off", "control", "broke", 4)]),
          row(8, "held", [cell("reorder-on", "required", "pass"), cell("reorder-off", "control", "pass")]),
          // A row a control proved is not a limit, and neither is a red one.
          row(12, "proven", [cell("reorder-on", "required", "pass"), cell("reorder-off", "control", "fail", 14)]),
          row(16, "failed", [cell("reorder-on", "required", "fail", 18), cell("reorder-off", "control", "pass")]),
        ],
      },
    };
    expect(limitsOf(document)).toEqual([
      {
        kind: "control-not-proving",
        feature: "features/orders.feature",
        line: 3,
        text: "criterion 3",
        detail: "no control failed at a Then where its conditions do not hold (reorder-off: broke@4)",
        record: "steps/c",
        fix: "make the steps before the Then run where its conditions do not hold, so the Then is what fails there",
      },
      {
        kind: "control-not-proving",
        feature: "features/orders.feature",
        line: 8,
        text: "criterion 8",
        detail: "no control failed at a Then where its conditions do not hold (reorder-off: pass)",
        fix: "make the Then check what its condition switches, or check that the control's environment switches it",
      },
    ]);
    expect(limitsSection(renderRunSummary(document))).toEqual([
      "- **Held, and no control failed at a Then** (`control-not-proving`, 2): a control of each criterion below ran where its conditions do not hold, " +
        "and none failed at a Then, so nothing shows its Then notices the behaviour is absent",
      "  - `features/orders.feature:3` criterion 3: no control failed at a Then where its conditions do not hold (reorder-off: broke@4); record `steps/c`; " +
        "fix: make the steps before the Then run where its conditions do not hold, so the Then is what fails there",
      "  - `features/orders.feature:8` criterion 8: no control failed at a Then where its conditions do not hold (reorder-off: pass); " +
        "fix: make the Then check what its condition switches, or check that the control's environment switches it",
    ]);
  });

  it("names a scenario no claim judged once, and not again as a control that did not fail, and leaves a red row to its reason", () => {
    const document: RunDocument = {
      ...base,
      ...twoEnvironments,
      scenarios: [
        execution(3, "reorder-on", "required", "passed", [step(4, "passed", "steps/a")], { judged_by: "nothing" }),
        execution(3, "reorder-off", "control", "passed", [step(4, "passed", "steps/b")], { judged_by: "nothing" }),
        execution(8, "reorder-on", "required", "failed", [step(9, "failed", "steps/c")], { judged_by: "nothing" }),
      ],
      table: {
        ...base.table,
        rows: [
          row(3, "held", [cell("reorder-on", "required", "pass"), cell("reorder-off", "control", "pass")]),
          row(8, "failed", [cell("reorder-on", "required", "broke", 9)]),
        ],
      },
    };
    expect(limitsOf(document).map((limit) => [limit.kind, limit.line])).toEqual([["no-claim", 3]]);
  });

  it("names a step's environment in a run of several, and keeps one entry per step and gap under --repeat", () => {
    const unmeasured = { processes: null, http: null, files: null, unmeasured: [{ kind: "socket" as const, detail: "connect db:5432" }] };
    const document: RunDocument = {
      ...base,
      ...twoEnvironments,
      scenarios: [
        execution(3, "reorder-on", "required", "passed", [step(4, "passed", "steps/a", { observed: unmeasured })]),
        execution(3, "reorder-on", "required", "passed", [step(4, "passed", "steps/b", { observed: unmeasured })]),
        execution(3, "reorder-off", "required", "passed", [step(4, "passed", "steps/c", { observed: unmeasured })]),
      ],
    };
    expect(limitsSection(renderRunSummary(document))).toEqual([
      "- **Unmeasured actions** (`unmeasured`, 2): each step below did something nukadoko records but cannot measure, so its record has no evidence of what that action did",
      "  - `features/orders.feature:4` step 4 (reorder-on): socket `connect db:5432`; record `steps/a`",
      "  - `features/orders.feature:4` step 4 (reorder-off): socket `connect db:5432`; record `steps/c`",
    ]);
  });

  it("reads the list again from the other fields, whatever run.json's own limits says", () => {
    const document = { ...base, check: "skipped", limits: [{ kind: "no-claim", detail: 7 }, null] } as unknown as RunDocument;
    expect(limitsSection(renderRunSummary(document))).toEqual([
      "- **Static check skipped** (`check-skipped`): the run started with `nuka run --no-check`, so no finding of `nuka check` held it back; do: `nuka check`",
    ]);
    expect(renderRunSummary({ ...base, limits: [{ kind: "no-claim", detail: "made up" }] })).not.toContain("What this run does not show");
  });

  it("writes one stderr line counting each kind in the summary's order, and nothing for a run with none", () => {
    const stderr = createCaptureSink();
    writeLimitCounts(stderr, [{ kind: "no-claim" }, { kind: "check-skipped" }, { kind: "no-claim" }]);
    writeLimitCounts(stderr, []);
    expect(stderr.text()).toBe("limits: 2 no-claim, 1 check-skipped (run.json limits)\n");
  });
});

// Any run document the record types allow, as far as limitsOf reads it:
// rows of every verdict with head, base, and old cells of either role;
// executions of any status, judged or not, with steps that carry any of
// the per-step gaps; worlds of any tree with any program log and events.
// A Gherkin line holds no line break, so names and texts are drawn from
// one line's characters, among them the ones the Markdown escaping
// handles.
function drawDocument(tc: hegel.TestCase): RunDocument {
  const environments = tc.draw(gs.sampledFrom([["default"], ["on", "off"], ["on", "off", "staging"]]));
  const lines = tc.draw(gs.arrays(gs.integers({ minValue: 1, maxValue: 40 }), { maxSize: 6, unique: true }));
  const features = ["features/a.feature", "features/b.feature"];
  const outcome = (): RunTableCell["outcome"] => tc.draw(gs.sampledFrom(["pass", "fail", "broke", "flaky", "stopped", "not-run"] as const));
  const rows: RunTableRow[] = lines.map((line) => ({
    feature: tc.draw(gs.sampledFrom(features)),
    line,
    name: tc.draw(gs.text({ maxSize: 8, alphabet: "ab |<`\\" })),
    change: tc.draw(gs.sampledFrom([null, "unchanged", "changed", "new"] as const)),
    conditions: [],
    cells: environments.flatMap((environment) =>
      tc.draw(gs.booleans()) ? [] : [{ ...cell(environment, tc.draw(gs.sampledFrom(["required", "control"] as const)), outcome(), line), world: tc.draw(gs.sampledFrom(["head", "head", "base", "old"] as const)) }],
    ),
    verdict: tc.draw(gs.sampledFrom(["held", "proven", "failed", "unproven", "moved", "removed"] as const)),
    reason: "a reason",
  }));
  const late = () => (tc.draw(gs.booleans()) ? { lines: tc.draw(gs.integers({ minValue: 1, maxValue: 3 })), file: tc.draw(gs.sampledFrom([null, "late.txt"])) } : undefined);
  const drawStep = (line: number): RunStep => ({
    line: tc.draw(gs.sampledFrom([null, line + 1, line + 2])),
    text: tc.draw(gs.text({ maxSize: 8, alphabet: "ab |<`\\" })),
    step: "s",
    status: tc.draw(gs.sampledFrom(["passed", "failed", "skipped", "undefined"] as const)),
    step_record_id: null,
    record: tc.draw(gs.sampledFrom([null, "steps/x", "steps/y"])),
    ...(tc.draw(gs.booleans())
      ? {
          observed: {
            processes: null,
            http: null,
            files: null,
            unmeasured: tc.draw(gs.arrays(gs.sampledFrom([{ kind: "child_process" as const, detail: "exec `git`" }, { kind: "socket" as const, detail: "a|b<c" }]), { maxSize: 5 })),
          },
        }
      : {}),
    ...(tc.draw(gs.booleans()) ? { after_step_end: { requests: tc.draw(gs.integers({ minValue: 0, maxValue: 2 })), processes: tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) } } : {}),
    ...((): Partial<RunStep> => {
      const log = late();
      const events = late();
      return { ...(log === undefined ? {} : { program_log_late: log }), ...(events === undefined ? {} : { events_late: events }) };
    })(),
  });
  const scenarios: RunScenario[] = tc.draw(gs.arrays(gs.sampledFrom<{ readonly feature: string; readonly line: number }>(rows.length === 0 ? [{ feature: "features/a.feature", line: 1 }] : rows), { maxSize: 8 })).map((at, index) => ({
    scenario_record_id: `scn-${index}`,
    feature: at.feature,
    line: at.line,
    scenario: "a scenario",
    environment: tc.draw(gs.sampledFrom(environments)),
    ...(tc.draw(gs.booleans()) ? { role: tc.draw(gs.sampledFrom(["required", "control"] as const)) } : {}),
    ...(tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0 ? { world: tc.draw(gs.sampledFrom(["base", "old"] as const)) } : {}),
    status: tc.draw(gs.sampledFrom(["passed", "failed", "stopped"] as const)),
    started_at: base.started_at,
    finished_at: base.finished_at,
    steps: tc.draw(gs.arrays(gs.just(0), { maxSize: 3 })).map(() => drawStep(at.line)),
    hooks: [],
    ...(tc.draw(gs.booleans()) ? { judged_by: tc.draw(gs.sampledFrom(["compat", "nothing"] as const)) } : {}),
  }));
  const count = () => tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  const worlds: RunWorld[] = environments.flatMap((name) =>
    tc.draw(gs.booleans())
      ? []
      : [
          {
            name,
            tree: tc.draw(gs.sampledFrom(["head", "base", "old"] as const)),
            url: tc.draw(gs.sampledFrom([null, "http://localhost:1"])),
            commands: [],
            timings: {},
            log: null,
            error: null,
            ...(tc.draw(gs.booleans()) ? { program_log: tc.draw(gs.booleans()) ? null : { stamped: count(), lines: count(), late: count(), tagged: count() } } : {}),
            ...(tc.draw(gs.booleans())
              ? {
                  events: tc.draw(gs.booleans())
                    ? null
                    : { file: tc.draw(gs.sampledFrom([null, "worlds/x/events.jsonl"])), lines: count(), owned: count(), late: count(), unowned: count(), unreadable: count(), undefined_kinds: tc.draw(gs.booleans()) ? ({} as Record<string, number>) : { queue: 2 } },
                }
              : {}),
          },
        ],
  );
  return {
    ...base,
    environments: environments.map((name) => ({ name, target_version: null })),
    ...(tc.draw(gs.booleans()) ? { check: tc.draw(gs.sampledFrom(["ran", "skipped"] as const)) } : {}),
    ...(tc.draw(gs.booleans()) ? { worlds } : {}),
    scenarios,
    table: { ...base.table, worlds: environments.map((environment) => ({ world: "head" as const, environment })), rows, left_out: count() },
  };
}

// Whether `limit` names something `document` holds: a row or a head
// execution with its steps' lines, or a world.
function namesSomethingIn(limit: RunLimit, document: RunDocument): boolean {
  if (limit.feature !== undefined) {
    const head = document.scenarios.filter((scenario) => scenario.world === undefined && scenario.feature === limit.feature);
    if (limit.kind === "control-not-proving") return document.table.rows.some((entry) => entry.feature === limit.feature && entry.line === limit.line && entry.verdict === "held");
    if (limit.kind === "no-claim") return head.some((scenario) => scenario.line === limit.line && scenario.role !== "control" && scenario.judged_by !== undefined);
    return head.some((scenario) => scenario.environment === limit.environment && scenario.steps.some((entry) => (entry.line ?? scenario.line) === limit.line && entry.text === limit.text));
  }
  if (limit.world !== undefined) return (document.worlds ?? []).some((world) => world.name === limit.environment && world.tree === limit.world);
  return limit.kind === "left-out" ? document.table.left_out > 0 : document.check === "skipped";
}

describe("limitsOf over any run document", () => {
  it("never throws, names only what the document holds, keeps the summary's kind order, and the summary lists each entry", () =>
    hegel.test((tc) => {
      const document = drawDocument(tc);
      const limits = limitsOf(document);
      for (const limit of limits) expect(namesSomethingIn(limit, document), JSON.stringify(limit)).toBe(true);
      const ranks = limits.map((limit) => LIMIT_KINDS.indexOf(limit.kind));
      expect(ranks.every((rank) => rank !== -1)).toBe(true);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      const section = limitsSection(renderRunSummary(document)).join("\n");
      expect(section === "").toBe(limits.length === 0);
      for (const limit of limits) expect(section).toContain(limit.detail);
    }));

  it("gives no entry about a criterion to a red row, which is only the table's, and a control entry only to a held row with a head control", () =>
    hegel.test((tc) => {
      const document = drawDocument(tc);
      const red = new Set(["failed", "unproven", "moved"]);
      for (const limit of limitsOf(document).filter((entry) => entry.kind === "control-not-proving" || entry.kind === "no-claim")) {
        const rows = document.table.rows.filter((entry) => entry.feature === limit.feature && entry.line === limit.line);
        expect(rows.some((entry) => red.has(entry.verdict))).toBe(false);
        if (limit.kind === "control-not-proving") {
          expect(rows.some((entry) => entry.verdict === "held" && entry.cells.some((cell) => cell.world === "head" && cell.role === "control"))).toBe(true);
        }
      }
    }));
});
