import { EXPECTED_KIND_ORDER, expectsTagText, readExpectsTag, type ExpectedKind } from "../condition/condition.js";
import type { HttpLogEntry } from "../context/http-log-read.js";
import type { Finding } from "../finding/finding.js";
import type { RunPageErrorGroup, RunScenario, RunStatusGroup, RunStep, RunUnderneath } from "../record/run-result.js";
import type { HttpOmittedCounts, PageEventsSnapshot } from "../record/types.js";
import { stepJudgedTooEarly } from "./events-after-stop.js";
import { firstErrorLine, scenarioLabel, type RunConditions } from "./progress-log.js";
import { countOf } from "./summary-markdown.js";

// Responsibility: the failures underneath an execution (docs/spec.md
// "Failures underneath"): what its steps saw of the program failing,
// grouped by what an `@expects:` tag names; which of them no tag of the
// scenario accepts, which turns a pass broke in its cell; and the findings
// that say so. Boundary: pure, over a step record's `page_events` and the
// parsed lines of its http.jsonl, and over run.json's scenarios. Reading
// the files is src/cli/run.ts's, folding the program's execution events
// into a step's `path` is the world's stop's, and folding a cell is
// src/run/verdict-table.ts's.
//
// Only a measured failure is counted: a line of http.jsonl with a status
// from 500 to 599, and a page error on the record. Each is the failing
// party's own statement, never a reading of something else: the server
// chose the status, and the browser found no handler for what the page
// threw. What could not be seen (a line that was not written or does not
// parse, a page error past the record's cap, a page's request left out
// of http.jsonl, whose status was never kept) is kept apart as `unseen`,
// and is never counted as a failure.

/** The lowest and highest status a server answers with when it failed. */
const FAILED_STATUS = { from: 500, to: 599 } as const;

/** A step's `underneath`, from its record's `page_events`, its http.jsonl
 * lines (`null` when the file could not be read, empty when the record
 * names none), its `http_log_failed`, and its `http_omitted`.
 * `undefined` when the step saw no failure and missed nothing. Pure. */
export function underneathOfRecord(
  pageEvents: PageEventsSnapshot | undefined,
  http: readonly (HttpLogEntry | null)[] | null,
  httpLogFailed: number | undefined,
  httpOmitted: HttpOmittedCounts | undefined,
): RunUnderneath | undefined {
  const statuses = statusGroups(http ?? []);
  const pageErrors = pageErrorGroups(pageEvents);
  const kept = pageEvents?.page_errors?.length ?? 0;
  const pastCap = pageEvents?.truncated?.page_errors === undefined ? 0 : pageEvents.truncated.page_errors - kept;
  const unparsed = (http ?? []).filter((entry) => entry === null).length;
  const httpLines = http === null ? null : unparsed + (httpLogFailed ?? 0);
  const omitted = Object.values(httpOmitted ?? {}).reduce((sum, count) => sum + count, 0);
  const unseen = {
    ...(httpLines === null || httpLines > 0 ? { http_lines: httpLines } : {}),
    ...(omitted > 0 ? { http_omitted: omitted } : {}),
    ...(pastCap > 0 ? { page_errors: pastCap } : {}),
  };
  const underneath: RunUnderneath = {
    ...(statuses.length === 0 ? {} : { statuses }),
    ...(pageErrors.length === 0 ? {} : { page_errors: pageErrors }),
    ...(Object.keys(unseen).length === 0 ? {} : { unseen }),
  };
  return Object.keys(underneath).length === 0 ? undefined : underneath;
}

function statusGroups(http: readonly (HttpLogEntry | null)[]): RunStatusGroup[] {
  const groups = new Map<number, { count: number; first: RunStatusGroup["first"] }>();
  http.forEach((entry, index) => {
    if (entry === null || entry.status < FAILED_STATUS.from || entry.status > FAILED_STATUS.to) return;
    const group = groups.get(entry.status);
    if (group !== undefined) {
      group.count += 1;
      return;
    }
    groups.set(entry.status, {
      count: 1,
      first: { method: entry.method, url: entry.url, via: entry.via, http_line: index, ...(entry.as === undefined ? {} : { as: entry.as }) },
    });
  });
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([status, group]) => ({ status, ...group }));
}

function pageErrorGroups(pageEvents: PageEventsSnapshot | undefined): RunPageErrorGroup[] {
  const groups = new Map<string | null, { count: number; first: RunPageErrorGroup["first"] }>();
  for (const entry of pageEvents?.page_errors ?? []) {
    const name = entry.name ?? null;
    const group = groups.get(name);
    if (group !== undefined) {
      group.count += 1;
      continue;
    }
    groups.set(name, { count: 1, first: { message: firstErrorLine(entry.message), ...(entry.as === undefined ? {} : { as: entry.as }) } });
  }
  return [...groups.entries()].map(([name, group]) => ({ name, ...group }));
}

/** A failure underneath one execution, by the key an `@expects:` tag
 * names, under the step it arrived at. */
export type SeenFailure = {
  /** The step's index in the execution. */
  readonly step: number;
  /** The step's line, or the scenario's when the step names none. */
  readonly line: number;
  /** How many arrived under the step: responses, page errors, or the
   * program's lines that reported the error. */
  readonly count: number;
  /** The tag that accepts it, as `expectsTagText` writes it, or `null`
   * when no tag of the scenario does. */
  readonly expectedBy: string | null;
} & (
  | { readonly kind: "status"; readonly value: string; readonly first: RunStatusGroup["first"] }
  | { readonly kind: "error"; readonly value: string }
  | { readonly kind: "page-error"; readonly value: string | null; readonly first: RunPageErrorGroup["first"] }
);

type UnderneathStep = Pick<RunStep, "line" | "underneath" | "path">;

/** What the judgment reads of an execution: run.json's fields alone, so a
 * run.json copied off a machine is judged the same. */
export type Underneath = Pick<RunScenario, "line" | "expects"> & { readonly steps: readonly UnderneathStep[] };

type Found = Omit<SeenFailure, "step" | "line" | "expectedBy">;

// Where each kind is read under one step. An unhandled error is the
// step's `path` entry, which the world's stop folded from every line of
// its trace; a `handled: true` error is the program going on, not failing.
const FOUND_UNDER: { readonly [K in ExpectedKind]: (step: UnderneathStep) => readonly Found[] } = {
  status: (step) => (step.underneath?.statuses ?? []).map((group) => ({ kind: "status", value: String(group.status), count: group.count, first: group.first })),
  error: (step) => (step.path?.entries ?? []).flatMap((entry): Found[] => (entry.kind === "error" && !entry.handled ? [{ kind: "error", value: entry.class, count: entry.count }] : [])),
  "page-error": (step) => (step.underneath?.page_errors ?? []).map((group) => ({ kind: "page-error", value: group.name, count: group.count, first: group.first })),
};

/** Every failure underneath `execution`, steps in order and, within a
 * step, by `EXPECTED_KINDS` order, each with the tag that accepts it.
 * Pure. */
export function failuresUnderneath(execution: Underneath): readonly SeenFailure[] {
  const accepted = new Set((execution.expects ?? []).flatMap((tag) => (readExpectsTag(tag) === undefined ? [] : [tag])));
  return execution.steps.flatMap((step, index) =>
    EXPECTED_KIND_ORDER.flatMap((kind) =>
      FOUND_UNDER[kind](step).map((found) => {
        const tag = found.value === null ? null : expectsTagText({ kind: found.kind, value: found.value });
        // A spread of a union loses which member it is; each member of
        // `found` gains the same three fields, so the result is one too.
        return { ...found, step: index, line: step.line ?? execution.line, expectedBy: tag !== null && accepted.has(tag) ? tag : null } as SeenFailure;
      }),
    ),
  );
}

/** The first failure underneath `execution` no tag of its scenario
 * accepts: what turns a pass broke. Pure. */
export function firstUnexpected(execution: Underneath): SeenFailure | undefined {
  return failuresUnderneath(execution).find((failure) => failure.expectedBy === null);
}

// A request as a reason names it: its method and its path. The port of a
// world the run started differs from run to run, and a page may add a
// query that defeats a cache, so the full URL would make two runs that
// failed the same way disagree; the finding names it.
function requestOf(first: RunStatusGroup["first"]): string {
  try {
    return `${first.method} ${new URL(first.url).pathname}`;
  } catch {
    return `${first.method} ${first.url}`;
  }
}

/** The cell's reason for `failure`: the step's line and the failure's
 * key, never a count or a message, so two runs that failed the same way
 * agree (`foldCell`). Pure. */
export function unexpectedReason(failure: SeenFailure): string {
  const unnamed = "which no @expects tag of the scenario names";
  if (failure.kind === "status") return `the step at line ${failure.line} got a ${failure.value} response to ${requestOf(failure.first)}, ${unnamed}`;
  if (failure.kind === "error") return `the program reported an unhandled ${failure.value} in the trace of the step at line ${failure.line}, ${unnamed}`;
  return failure.value === null
    ? `the page threw an uncaught error with no name while the step at line ${failure.line} ran, which no @expects tag can name`
    : `the page threw an uncaught ${failure.value} while the step at line ${failure.line} ran, ${unnamed}`;
}

/** `failure` as a finding and the summary name it, with where its first
 * occurrence is. Pure. */
export function failureText(failure: SeenFailure): string {
  if (failure.kind === "status") {
    const { first } = failure;
    return `${countOf(failure.count, "response", "responses")} with status ${failure.value}, first ${first.method} ${first.url} (${first.via}, http.jsonl[${first.http_line}])`;
  }
  if (failure.kind === "error") return `${countOf(failure.count, "line", "lines")} of the program's execution events reporting an unhandled ${failure.value}`;
  const what = failure.value === null ? "error with no name" : failure.value;
  return `${countOf(failure.count, `uncaught ${what}`, `uncaught ${what}s`)} from the page, first ${JSON.stringify(failure.first.message)}`;
}

/** The failure underneath that turns `execution` broke in its cell: it
 * passed, no claim of it was judged too early (which is its own broke,
 * src/run/events-after-stop.ts), and a failure underneath it is one no
 * tag of its scenario accepts. Only a pass: a fail is already the first
 * failure that counts, and where the behaviour is absent it is the proof.
 * Pure. */
export function demotingFailure(execution: Pick<RunScenario, "status" | "line" | "expects" | "steps">): SeenFailure | undefined {
  if (execution.status !== "passed" || stepJudgedTooEarly(execution.steps) !== -1) return undefined;
  return firstUnexpected(execution);
}

/** One `unexpected-failure` finding per head required execution a
 * failure underneath turned broke, per scenario and environment, since the
 * runs of `--repeat` would say it again. It names every failure no tag
 * accepts under the first step that has one, and its `fix:` spells the tag
 * for each. A control gates nothing, and a base or an old cell is named by
 * its row's `criterion-unproven` or `criterion-moved` finding. Pure. */
export function unexpectedFailureFindings(scenarios: readonly RunScenario[], conditions: Pick<RunConditions, "named" | "rerun">): Finding[] {
  const findings = new Map<string, Finding>();
  for (const scenario of scenarios) {
    if (scenario.world !== undefined || scenario.role === "control") continue;
    const first = demotingFailure(scenario);
    const key = `${scenario.feature}:${scenario.line}:${scenario.environment}`;
    if (first === undefined || findings.has(key)) continue;
    const step = scenario.steps[first.step]!;
    const unexpected = failuresUnderneath(scenario).filter((failure) => failure.step === first.step && failure.expectedBy === null);
    const tags = [...new Set(unexpected.flatMap((failure) => (failure.value === null ? [] : [expectsTagText({ kind: failure.kind, value: failure.value })])))];
    findings.set(key, {
      severity: "failed",
      code: "unexpected-failure",
      file: scenario.feature,
      line: first.line,
      message:
        `${scenarioLabel(scenario.scenario, scenario.environment, conditions)}: its steps passed, and the program failed underneath the step at line ${first.line}, ` +
        `${JSON.stringify(step.text)}, in a way no @expects tag names, so its cell is broke: ${unexpected.map(failureText).join("; ")}${step.record === null ? "" : `; record ${step.record}`}`,
      fix:
        tags.length === 0
          ? "Fix what failed: the page threw an error with no name, which no @expects tag can accept."
          : `Fix what failed. A scenario that causes it on purpose names it on its Scenario line: ${tags.join(" ")}`,
      do: conditions.rerun(scenario),
    });
  }
  return [...findings.values()];
}

// Whether an execution was watched for a kind whole, so a tag of that kind
// that matched nothing there matched nothing that happened: every line of
// http.jsonl read and no page request left out of it (a script's 503 is
// never kept), the page errors of a browser kept by name, or the
// program's events read with no line that may be any line and no gap
// where an error could still be, such as a job that never performed. A
// step that sent no request has a gap too (`no-requests`), and no
// error of its trace can be missing, so it does not count.
const WATCHED: { readonly [K in ExpectedKind]: (execution: RunScenario) => boolean } = {
  status: (execution) =>
    execution.steps.every((step) => step.record_unreadable !== true && step.underneath?.unseen?.http_lines === undefined && step.underneath?.unseen?.http_omitted === undefined),
  error: (execution) =>
    execution.steps.some((step) => step.path !== undefined) && execution.steps.every((step) => (step.path?.maybe ?? 0) === 0 && (step.path?.open ?? []).every((open) => open.gap === "no-requests")),
  "page-error": (execution) => execution.browser !== undefined && execution.steps.every((step) => step.record_unreadable !== true && step.underneath?.unseen?.page_errors === undefined),
};

const NOT_SEEN: { readonly [K in ExpectedKind]: (value: string) => string } = {
  status: (value) => `no step got a ${value} response`,
  error: (value) => `the program reported no unhandled ${value}`,
  "page-error": (value) => `the page threw no uncaught ${value}`,
};

/** One `expects-unseen` note per tag of a head required scenario, per
 * environment, whose every execution passed and matched no failure that
 * tag accepts, where each was watched for its kind whole. A tag left in
 * place after its failure stopped happening accepts that failure in every
 * later run, which is how an expectation widens with nobody writing a
 * line. Pure. */
export function unseenExpectationNotes(scenarios: readonly RunScenario[], conditions: Pick<RunConditions, "named">): Finding[] {
  const cells = new Map<string, RunScenario[]>();
  for (const scenario of scenarios) {
    if (scenario.world !== undefined || scenario.role === "control" || (scenario.expects ?? []).length === 0) continue;
    const key = `${scenario.feature}\u0000${scenario.line}\u0000${scenario.environment}`;
    cells.set(key, [...(cells.get(key) ?? []), scenario]);
  }
  const notes: Finding[] = [];
  for (const executions of cells.values()) {
    const passed = executions.every((execution) => execution.status === "passed" && stepJudgedTooEarly(execution.steps) === -1 && firstUnexpected(execution) === undefined);
    if (!passed) continue;
    const matched = new Set(executions.flatMap((execution) => failuresUnderneath(execution).flatMap((failure) => (failure.expectedBy === null ? [] : [failure.expectedBy]))));
    const first = executions[0]!;
    for (const tag of first.expects ?? []) {
      const expected = readExpectsTag(tag);
      if (expected === undefined || matched.has(tag) || !executions.every(WATCHED[expected.kind])) continue;
      notes.push({
        severity: "note",
        code: "expects-unseen",
        file: first.feature,
        line: first.line,
        message:
          `${scenarioLabel(first.scenario, first.environment, conditions)}: ${tag} accepts a failure that did not happen: ` +
          `${NOT_SEEN[expected.kind](expected.value)} in ${executions.length === 1 ? "its execution" : `any of its ${executions.length} executions`}`,
      });
    }
  }
  return notes;
}
