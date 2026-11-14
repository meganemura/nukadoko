import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { PathEntry, StepPath } from "../src/execution-events/path.js";
import type { RunClaim, RunScenario, RunStep, RunUnderneath } from "../src/record/run-result.js";
import { failuresUnderneath, unexpectedFailureFindings, unseenExpectationNotes } from "../src/run/underneath.js";
import { executionOutcome, foldCell } from "../src/run/verdict-table.js";

// Responsibility: how a failure underneath an execution (docs/spec.md
// "Failures underneath") judges its cell: only a pass moves, and only to
// broke; an @expects: tag that names a failure accepts it, so a tag never
// turns a pass broke; what could not be seen never demotes; two runs that
// failed the same way agree, whatever host, port, query, count, or message
// they saw; and the findings that go with it name a head required cell once,
// and a tag that matched nothing only where its kind was watched whole.

const STATUSES = [500, 503, 599] as const;
const NAMES = ["Error", "TypeError", null] as const;
const CLASSES = ["Boom::Exploded", "Ledger::Stale"] as const;
const EVERY_TAG = [
  ...STATUSES.map((status) => `@expects:status=${status}`),
  ...NAMES.flatMap((name) => (name === null ? [] : [`@expects:page-error=${name}`])),
  ...CLASSES.map((name) => `@expects:error=${name}`),
];

const host = gs.sampledFrom(["http://127.0.0.1:4100", "http://localhost:51234"]);
const statusGroup = gs.tuples(gs.sampledFrom(STATUSES), gs.integers({ minValue: 1, maxValue: 4 }), host, gs.integers({ minValue: 0, maxValue: 9 })).map(
  ([status, count, origin, line]) => ({ status, count, first: { method: "GET", url: `${origin}/broken?x=1`, via: "fetch" as const, http_line: line } }),
);
const pageErrorGroup = gs.tuples(gs.sampledFrom(NAMES), gs.integers({ minValue: 1, maxValue: 3 }), gs.sampledFrom(["boom", "kaboom"])).map(([name, count, message]) => ({
  name,
  count,
  first: { message },
}));
type ErrorEntry = PathEntry & { readonly kind: "error"; readonly class: string; readonly handled: boolean };
const errorEntry = gs.tuples(gs.sampledFrom(CLASSES), gs.booleans(), gs.integers({ minValue: 1, maxValue: 3 })).map(
  ([name, handled, count]): ErrorEntry => ({ kind: "error", class: name, handled, count }),
);
const unseen = gs.sampledFrom<RunUnderneath["unseen"] | undefined>([undefined, { http_lines: null }, { http_lines: 2 }, { http_omitted: 3 }, { page_errors: 1 }, { http_lines: 1, page_errors: 3 }]);

function underneathOf(statuses: RunUnderneath["statuses"], pageErrors: RunUnderneath["page_errors"], missed: RunUnderneath["unseen"] | null | undefined): RunUnderneath | undefined {
  const underneath: RunUnderneath = {
    ...(statuses === undefined || statuses.length === 0 ? {} : { statuses: [...new Map(statuses.map((group) => [group.status, group])).values()].sort((a, b) => a.status - b.status) }),
    ...(pageErrors === undefined || pageErrors.length === 0 ? {} : { page_errors: [...new Map(pageErrors.map((group) => [group.name, group])).values()] }),
    ...(missed === null || missed === undefined || Object.keys(missed).length === 0 ? {} : { unseen: missed }),
  };
  return Object.keys(underneath).length === 0 ? undefined : underneath;
}

const pathOf = (entries: readonly PathEntry[]): StepPath => ({ requests: [], entries, maybe: 0, open: [] });

const step = gs
  .tuples(gs.arrays(statusGroup, { maxSize: 2 }), gs.arrays(pageErrorGroup, { maxSize: 2 }), gs.arrays(errorEntry, { maxSize: 2 }), unseen)
  .map(([statuses, pageErrors, errors, missed]) => ({ statuses, pageErrors, errors, missed }));

function stepOf(index: number, drawn: { statuses: RunUnderneath["statuses"]; pageErrors: RunUnderneath["page_errors"]; errors: readonly ErrorEntry[]; missed: RunUnderneath["unseen"] | null | undefined }): RunStep {
  const underneath = underneathOf(drawn.statuses, drawn.pageErrors, drawn.missed);
  return {
    line: 4 + index,
    text: `step ${index}`,
    step: null,
    status: "passed",
    step_record_id: `step-${index}`,
    record: `steps/step-${index}`,
    ...(underneath === undefined ? {} : { underneath }),
    ...(drawn.errors.length === 0 ? {} : { path: pathOf([...new Map(drawn.errors.map((entry) => [JSON.stringify([entry.class, entry.handled]), entry])).values()]) }),
  };
}

function execution(steps: readonly RunStep[], expects: readonly string[], overrides: Partial<RunScenario> = {}): RunScenario {
  return {
    scenario_record_id: "scn-1",
    feature: "features/a.feature",
    line: 3,
    scenario: "a scenario",
    environment: "default",
    status: "passed",
    started_at: "2026-11-04T00:00:00.000Z",
    finished_at: "2026-11-04T00:00:01.000Z",
    steps,
    hooks: [],
    role: "required",
    ...(expects.length === 0 ? {} : { expects }),
    ...overrides,
  };
}

const drawExecution = (tc: hegel.TestCase, expects: readonly string[] = []): RunScenario =>
  execution(
    tc.draw(gs.arrays(step, { maxSize: 3 })).map((drawn, index) => stepOf(index, drawn)),
    expects,
  );

const subsetOf = (tc: hegel.TestCase, tags: readonly string[]): string[] => tags.filter(() => tc.draw(gs.booleans()));
const inThen = (): boolean => true;
const conditions = { named: false, rerun: (scenario: { feature: string; line: number }) => `nuka run ${scenario.feature}:${scenario.line}` };

describe("a failure underneath judges a pass", () => {
  it("never turns a pass broke by adding an @expects tag", () =>
    hegel.test((tc) => {
      const fewer = subsetOf(tc, EVERY_TAG);
      const more = [...fewer, ...subsetOf(tc, EVERY_TAG.filter((tag) => !fewer.includes(tag)))];
      const base = drawExecution(tc, fewer);
      if (executionOutcome(base, inThen).kind !== "pass") return;
      expect(executionOutcome({ ...base, ...(more.length === 0 ? {} : { expects: more }) }, inThen)).toEqual({ kind: "pass" });
    }));

  it("is a pass whose tags name every failure underneath it, and broke at the first step with one they do not", () =>
    hegel.test((tc) => {
      const drawn = drawExecution(tc);
      const failures = failuresUnderneath(drawn);
      const named = [...new Set(failures.flatMap((failure) => (failure.value === null ? [] : [`@expects:${failure.kind}=${failure.value}`])))];
      const allNamed = failures.every((failure) => failure.value !== null);
      expect(executionOutcome({ ...drawn, ...(named.length === 0 ? {} : { expects: named }) }, inThen).kind).toBe(allNamed ? "pass" : "broke");
      const outcome = executionOutcome(drawn, inThen);
      expect(outcome.kind).toBe(failures.length === 0 ? "pass" : "broke");
      if (outcome.kind === "broke") expect(outcome.line).toBe(drawn.steps[failures[0]!.step]!.line);
    }));

  it("moves only a pass: a failed or stopped execution comes to the same with or without what was underneath it", () =>
    hegel.test((tc) => {
      const drawn = drawExecution(tc);
      const status = tc.draw(gs.sampledFrom(["failed", "stopped"] as const));
      const ran: RunScenario = {
        ...drawn,
        status,
        ...(status === "stopped" ? { stopped: { after_step: 1, line: 4 } } : {}),
        steps: [...drawn.steps, { line: 20, text: "last", step: null, status: status === "failed" ? "failed" : "skipped", step_record_id: null, record: null }],
      };
      const bare: RunScenario = { ...ran, steps: ran.steps.map(({ underneath: _underneath, path: _path, ...rest }) => rest) };
      expect(executionOutcome(ran, inThen)).toEqual(executionOutcome(bare, inThen));
    }));

  it("never demotes for what could not be seen, or for an error the program handled", () =>
    hegel.test((tc) => {
      const steps = tc.draw(gs.arrays(gs.tuples(unseen, gs.arrays(errorEntry, { maxSize: 2 })), { maxSize: 3 })).map(([missed, errors], index) =>
        stepOf(index, { statuses: [], pageErrors: [], errors: errors.filter((entry) => entry.handled), missed }),
      );
      expect(executionOutcome(execution(steps, []), inThen)).toEqual({ kind: "pass" });
    }));

  it("agrees across two runs that failed the same way, whatever host, port, query, count, line, or message they saw", () =>
    hegel.test((tc) => {
      const drawn = drawExecution(tc);
      const again: RunScenario = {
        ...drawn,
        steps: drawn.steps.map((entry) => {
          if (entry.underneath === undefined) return entry;
          const statuses = entry.underneath.statuses?.map((group) => ({
            ...group,
            count: group.count + 1,
            first: { ...group.first, url: group.first.url.replace(/^http:\/\/[^/]+/, "http://127.0.0.1:59999").replace(/\?.*$/, `?_=${tc.draw(gs.integers({ minValue: 0 }))}`), http_line: group.first.http_line + 3 },
          }));
          const pageErrors = entry.underneath.page_errors?.map((group) => ({ ...group, count: group.count + 2, first: { message: `${group.first.message} again` } }));
          return { ...entry, underneath: { ...entry.underneath, ...(statuses === undefined ? {} : { statuses }), ...(pageErrors === undefined ? {} : { page_errors: pageErrors }) } };
        }),
      };
      const outcomes = [executionOutcome(drawn, inThen), executionOutcome(again, inThen)];
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(foldCell(outcomes).outcome).not.toBe("flaky");
    }));

  it("names the request by its method and path, never its host, port, or query", () => {
    const broke = execution([stepOf(0, { statuses: [{ status: 503, count: 2, first: { method: "POST", url: "http://127.0.0.1:4100/orders?id=7", via: "page", http_line: 1 } }], pageErrors: [], errors: [], missed: undefined })], []);
    expect(executionOutcome(broke, inThen)).toEqual({
      kind: "broke",
      line: 4,
      reason: "the step at line 4 got a 503 response to POST /orders, which no @expects tag of the scenario names",
    });
  });

  it("judges a claim judged too early before any failure underneath", () => {
    const early = execution(
      [
        {
          ...stepOf(0, { statuses: [{ status: 500, count: 1, first: { method: "GET", url: "http://a.test/", via: "fetch", http_line: 0 } }], pageErrors: [], errors: [], missed: undefined }),
          // Only what stepJudgedTooEarly reads of a claim.
          claims: [{ outcome: "held", after_world_stop: { lines: 2, outcome: "broken", reason: "late" } } as unknown as RunClaim],
        },
      ],
      [],
    );
    expect(executionOutcome(early, inThen)).toMatchObject({ kind: "broke", reason: "a claim at line 4 was judged before every execution event it counts had arrived" });
  });
});

describe("unexpected-failure", () => {
  const failing = (overrides: Partial<RunScenario> = {}): RunScenario =>
    execution(
      [
        stepOf(0, { statuses: [], pageErrors: [], errors: [], missed: undefined }),
        stepOf(1, {
          statuses: [{ status: 500, count: 1, first: { method: "GET", url: "http://127.0.0.1:4100/broken", via: "fetch", http_line: 0 } }],
          pageErrors: [{ name: null, count: 1, first: { message: "thrown" } }],
          errors: [{ kind: "error", class: "Boom::Exploded", handled: false, count: 2 }],
          missed: undefined,
        }),
      ],
      [],
      overrides,
    );

  it("names every failure no tag accepts under the first step with one, once per cell, and spells the tags that would", () => {
    const findings = unexpectedFailureFindings([failing(), failing({ scenario_record_id: "scn-2" })], conditions);
    expect(findings).toEqual([
      {
        severity: "failed",
        code: "unexpected-failure",
        file: "features/a.feature",
        line: 5,
        message:
          'a scenario: its steps passed, and the program failed underneath the step at line 5, "step 1", in a way no @expects tag names, so its cell is broke: ' +
          "1 response with status 500, first GET http://127.0.0.1:4100/broken (fetch, http.jsonl[0]); " +
          "2 lines of the program's execution events reporting an unhandled Boom::Exploded; " +
          '1 uncaught error with no name from the page, first "thrown"; record steps/step-1',
        fix: "Fix what failed. A scenario that causes it on purpose names it on its Scenario line: @expects:status=500 @expects:error=Boom::Exploded",
        do: "nuka run features/a.feature:3",
      },
    ]);
  });

  it("gates nothing for a control, a base or old execution, or one its tags accept", () => {
    expect(unexpectedFailureFindings([failing({ role: "control" }), failing({ world: "base" }), failing({ world: "old" })], conditions)).toEqual([]);
    const accepted = failing({ expects: ["@expects:status=500", "@expects:error=Boom::Exploded"] });
    expect(unexpectedFailureFindings([accepted], conditions).map((finding) => finding.message)).toEqual([expect.stringContaining('1 uncaught error with no name from the page, first "thrown"; record')]);
  });
});

describe("expects-unseen", () => {
  const clean = (overrides: Partial<RunScenario> = {}, missed?: RunUnderneath["unseen"]): RunScenario =>
    execution(
      [{ ...stepOf(0, { statuses: [], pageErrors: [], errors: [], missed }), path: pathOf([]) }],
      ["@expects:status=503", "@expects:error=Boom::Exploded", "@expects:page-error=TypeError"],
      { browser: { type: "chromium", version: "1" }, ...overrides },
    );

  it("notes each tag that matched nothing, where every execution was watched for its kind", () => {
    expect(unseenExpectationNotes([clean(), clean({ scenario_record_id: "scn-2" })], conditions).map((note) => note.message)).toEqual([
      "a scenario: @expects:status=503 accepts a failure that did not happen: no step got a 503 response in any of its 2 executions",
      "a scenario: @expects:error=Boom::Exploded accepts a failure that did not happen: the program reported no unhandled Boom::Exploded in any of its 2 executions",
      "a scenario: @expects:page-error=TypeError accepts a failure that did not happen: the page threw no uncaught TypeError in any of its 2 executions",
    ]);
  });

  it("stays silent on a kind the run could not see whole, and on a cell that did not pass", () => {
    const unwatched = clean({ steps: [stepOf(0, { statuses: [], pageErrors: [], errors: [], missed: { http_lines: null, page_errors: 2 } })] });
    expect(unseenExpectationNotes([unwatched], conditions)).toEqual([]);
    // A script that answered 503 is left out of http.jsonl with no status.
    const omitted = clean({}, { http_omitted: 1 });
    expect(unseenExpectationNotes([omitted], conditions).map((note) => note.message)).not.toContainEqual(expect.stringContaining("@expects:status="));
    expect(unseenExpectationNotes([omitted], conditions)).toHaveLength(2);
    // A job that never performed may have failed where no line says so; a
    // step that sent no request has no trace an error could be missing from.
    const gap = clean({ steps: [{ ...stepOf(0, { statuses: [], pageErrors: [], errors: [], missed: undefined }), path: { ...pathOf([]), open: [{ gap: "jobs-pending", job_ids: ["j1"] }] } }] });
    const quiet = clean({ steps: [{ ...stepOf(0, { statuses: [], pageErrors: [], errors: [], missed: undefined }), path: { ...pathOf([]), open: [{ gap: "no-requests" }] } }] });
    expect(unseenExpectationNotes([quiet], conditions).map((note) => note.message)).toContainEqual(expect.stringContaining("@expects:error="));
    expect(unseenExpectationNotes([gap], conditions).map((note) => note.message)).not.toContainEqual(expect.stringContaining("@expects:error="));
    const { browser: _browser, ...noBrowser } = clean();
    expect(unseenExpectationNotes([noBrowser], conditions).map((note) => note.message)).not.toContainEqual(expect.stringContaining("page-error"));
    expect(unseenExpectationNotes([clean(), clean({ scenario_record_id: "scn-2", status: "failed" })], conditions)).toEqual([]);
  });
});
