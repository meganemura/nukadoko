import { RED_VERDICTS, type RunFields, type RunLimit, type RunLimitKind, type RunScenario, type RunStep, type RunTableRow, type RunWorld } from "../record/run-result.js";
import { codeSpan, countOf } from "./summary-markdown.js";
import { cellText as cellWord, leftOutText } from "./verdict-table.js";

// Responsibility: what one run does not show (docs/spec.md "Records"),
// gathered from the fields run.json already holds into one list: a
// criterion `--env` left out, a check `--no-check` skipped, a held row
// whose control never failed at a Then, a scenario no claim judged, a
// step that did something its record has no evidence of, and what of the
// program's log and execution events no step record holds. Each entry is a
// gap a green verdict does not cover, under a kind a reader can count
// across runs.
//
// Boundary: pure, over run.json's fields alone, so a run.json copied off
// a CI machine reads the same, and the summary computes the list again
// instead of trusting a stored copy of it. It measures nothing: every
// entry restates a fact another field records. A `do` is given only where
// one command is known to close the gap, and a `fix` names an edit when
// none is.
//
// What is left out, on purpose. A red row: its reason under the table
// says why, and the exit code gates on it. A held row no control or base
// could have proven: that is what `held` means, so an entry on every row
// of a project with no conditions would only repeat the word. The commit,
// the selection, the order, and a walk: the summary's condition lines and
// title state each with its consequence. The routes no step requested and
// a flag's side no criterion evaluated: "Routes" and "Flags" are coverage
// maps with their own counts, and splitting their lists would leave a
// count line with nothing under it. A path comparison that stayed open or
// left a criterion out: "Changed paths" counts each beside the
// differences, and an unchanged criterion whose path changed is a finding
// about the change, not a gap in what the run measured.

/** The kinds in the order the summary lists them: what the criteria lack
 * first, then what a step's record lacks, then what the program wrote
 * that no record holds. */
export const LIMIT_KINDS: readonly RunLimitKind[] = [
  "left-out",
  "check-skipped",
  "control-not-proving",
  "no-claim",
  "judgment",
  "unmeasured",
  "after-record",
  "unrecorded-log",
  "unrecorded-events",
];

/** What `limitsOf` reads of a run. */
export type LimitSource = Pick<RunFields, "table" | "scenarios" | "worlds" | "check">;

// How many unmeasured actions one entry names before it counts the rest.
const UNMEASURED_SHOWN = 3;

/** Every limit of the run `fields` records, by kind in `LIMIT_KINDS`
 * order, and within a kind by feature file and line, or in world order. */
export function limitsOf(fields: LimitSource): RunLimit[] {
  const head = fields.scenarios.filter((scenario) => scenario.world === undefined);
  const byPlace = (a: RunLimit, b: RunLimit): number => (a.feature ?? "").localeCompare(b.feature ?? "") || (a.line ?? 0) - (b.line ?? 0);
  const limits: RunLimit[] = [];
  if (fields.table.left_out > 0) {
    limits.push({
      kind: "left-out",
      detail: leftOutText(fields.table.left_out),
      fix: "run again with `--env` naming an environment that meets their conditions",
    });
  }
  if (fields.check === "skipped") {
    limits.push({ kind: "check-skipped", detail: "the run started with `nuka run --no-check`, so no finding of `nuka check` held it back", do: "nuka check" });
  }
  // Whether a scenario judged a claim is read from its required
  // executions: a control that broke before its Then judged none either,
  // and that is the control's entry, not the scenario's. A red row's
  // reason already says it stopped before a claim was judged.
  const red = new Set(fields.table.rows.filter((row) => RED_VERDICTS.has(row.verdict)).map((row) => placeKey(row.feature, row.line)));
  const unjudged = head.filter(
    (scenario) => scenario.role !== "control" && scenario.judged_by !== undefined && scenario.judged_by !== "judgment" && !red.has(placeKey(scenario.feature, scenario.line)),
  );
  // A row a judgment decides compares nothing in its Then, so no control
  // of it could fail there: its entry is the judgment's, not a control's.
  const judgedRows = new Set(fields.table.rows.filter((row) => row.judgment !== undefined).map((row) => placeKey(row.feature, row.line)));
  // A scenario no claim judged is its own entry: a control of it passes
  // whatever the program does, and the fix a control entry names would
  // not close that.
  const unjudgedPlaces = new Set(unjudged.map((scenario) => placeKey(scenario.feature, scenario.line)));
  for (const row of fields.table.rows) {
    if (row.verdict !== "held" || unjudgedPlaces.has(placeKey(row.feature, row.line)) || judgedRows.has(placeKey(row.feature, row.line))) continue;
    const limit = controlLimit(row, head);
    if (limit !== undefined) limits.push(limit);
  }
  limits.push(...noClaimLimits(unjudged).sort(byPlace));
  limits.push(...judgmentLimits(fields.table.rows));
  limits.push(...stepLimits(head).sort(byPlace));
  for (const world of fields.worlds ?? []) limits.push(...worldLimits(world));
  const rank = (limit: RunLimit): number => LIMIT_KINDS.indexOf(limit.kind);
  // A stable sort keeps each kind's own order.
  return limits.sort((a, b) => rank(a) - rank(b));
}

function placeKey(feature: string, line: number): string {
  return `${feature}\u0000${line}`;
}

// A held row whose head controls ran where its conditions do not hold and
// none of them failed at a Then: the row named a switch, and nothing shows
// its Then notices the behaviour is gone. A control that broke before its
// Then (`broke@<line>`) is the case only run.json's `reason` said before.
function controlLimit(row: RunTableRow, head: readonly RunScenario[]): RunLimit | undefined {
  const controls = row.cells.filter((cell) => cell.world === "head" && cell.role === "control");
  if (controls.length === 0) return undefined;
  const outcomes = new Set(controls.map((cell) => cell.outcome));
  const fix = outcomes.has("pass")
    ? "make the Then check what its condition switches, or check that the control's environment switches it"
    : outcomes.has("broke")
      ? "make the steps before the Then run where its conditions do not hold, so the Then is what fails there"
      : undefined;
  // The record a reader opens next: where the first control that did not
  // pass stopped.
  const stopped = head.find(
    (scenario) =>
      scenario.feature === row.feature &&
      scenario.line === row.line &&
      scenario.role === "control" &&
      scenario.status !== "passed" &&
      controls.some((cell) => cell.environment === scenario.environment),
  );
  const record = stopped?.steps.find((step) => step.status !== "passed" && step.status !== "skipped")?.record ?? null;
  return {
    kind: "control-not-proving",
    feature: row.feature,
    line: row.line,
    text: row.name,
    detail: `no control failed at a Then where its conditions do not hold (${controls.map((cell) => `${cell.environment}: ${cellWord(cell)}`).join(", ")})`,
    ...(record === null ? {} : { record }),
    ...(fix === undefined ? {} : { fix }),
  };
}

// One entry per scenario in which no claim on a Then line was judged
// (run.json's `judged_by`), whatever its environments and repeats.
function noClaimLimits(unjudged: readonly RunScenario[]): RunLimit[] {
  const limits = new Map<string, RunLimit>();
  for (const scenario of unjudged) {
    if (scenario.judged_by === undefined) continue;
    const key = placeKey(scenario.feature, scenario.line);
    if (limits.has(key)) continue;
    limits.set(key, {
      kind: "no-claim",
      feature: scenario.feature,
      line: scenario.line,
      text: scenario.scenario,
      detail:
        scenario.judged_by === "compat"
          ? "no claim judged it, and a compat step in Then position may have, by throwing or not, where nukadoko cannot see what it checked"
          : "no claim on a Then line was judged in it",
      fix: "end the scenario with a Then whose step declares claims",
    });
  }
  return [...limits.values()];
}

// One entry per row a judgment holds green: nukadoko checked that the
// value is the one judged, and nothing of the judgment itself, so a green
// row that stands on a person's or an agent's word says so here. A value
// judged as an ARIA snapshot names what that leaves out: a change only to
// how the page looks keeps the snapshot, and so the judgment, as it is.
function judgmentLimits(rows: readonly RunTableRow[]): RunLimit[] {
  return rows.flatMap((row): RunLimit[] => {
    const judgment = row.judgment;
    if (judgment === undefined || judgment.state !== "judged") return [];
    const by = [...new Set(judgment.reads.map((read) => read.judgment?.by ?? ""))].map((name) => codeSpan(name)).join(", ");
    const aria = judgment.reads.some((read) => read.measured === "aria-snapshot")
      ? "; it is bound to the ARIA snapshot, so a change only to how the page looks keeps it current"
      : "";
    return [
      {
        kind: "judgment",
        feature: row.feature,
        line: row.line,
        text: row.name,
        detail: `stands on a judgment by ${by}: nukadoko checked that the value is the one judged, not the judgment${aria}`,
      },
    ];
  });
}

// Per step: what it did that nukadoko saw and could not measure
// (`observed.unmeasured`), and what reached its files after its record was
// written (`after_step_end`, `program_log_late`, `events_late`). Under
// `--repeat` the same step with the same gap is one entry, citing its
// first record.
function stepLimits(head: readonly RunScenario[]): RunLimit[] {
  const limits = new Map<string, RunLimit>();
  const add = (limit: RunLimit): void => {
    const { record: _record, ...rest } = limit;
    const key = JSON.stringify(rest);
    if (!limits.has(key)) limits.set(key, limit);
  };
  for (const scenario of head) {
    for (const step of scenario.steps) {
      const at = {
        feature: scenario.feature,
        line: step.line ?? scenario.line,
        text: step.text,
        environment: scenario.environment,
        ...(step.record === null ? {} : { record: step.record }),
      };
      const unmeasured = step.observed?.unmeasured ?? [];
      if (unmeasured.length > 0) {
        const shown = unmeasured.slice(0, UNMEASURED_SHOWN).map((entry) => `${entry.kind.replace("_", " ")} ${codeSpan(entry.detail)}`);
        if (unmeasured.length > UNMEASURED_SHOWN) shown.push(`and ${unmeasured.length - UNMEASURED_SHOWN} more`);
        add({
          kind: "unmeasured",
          ...at,
          detail: shown.join(", "),
          ...(unmeasured.some((entry) => entry.kind === "child_process") ? { fix: "start a process with `runCommand` to record it" } : {}),
        });
      }
      const unjudged = unjudgedFailures(step);
      if (unjudged.length > 0) add({ kind: "unmeasured", ...at, detail: unjudged.join(", ") });
      const late = lateItems(step);
      if (late.length > 0) add({ kind: "after-record", ...at, detail: late.join(", ") });
    }
  }
  return [...limits.values()];
}

// What of a step's failures underneath could not be seen
// (`underneath.unseen`): its cell was judged without them, so a failure
// among them neither turned it broke nor matched an @expects: tag.
function unjudgedFailures(step: RunStep): string[] {
  const unseen = step.underneath?.unseen;
  if (unseen === undefined) return [];
  return [
    ...(unseen.http_lines === null
      ? [`${codeSpan("http.jsonl")} could not be read, so no response status of the step was judged`]
      : unseen.http_lines !== undefined
        ? [`${countOf(unseen.http_lines, "request", "requests")} with no readable line in ${codeSpan("http.jsonl")}, whose status was not judged`]
        : []),
    ...(unseen.page_errors === undefined ? [] : [`${countOf(unseen.page_errors, "page error", "page errors")} past the record's cap, not judged`]),
  ];
}

// What reached a step's own files after its record was written: those
// lines are in the step's directory, but its record was already final,
// so this is the one place that says they exist, and names the file that
// holds them, which the record may not name.
function lateItems(step: RunStep): string[] {
  const items: string[] = [];
  const started = step.after_step_end;
  if (started !== undefined) {
    const parts = [
      ...(started.requests > 0 ? [`${countOf(started.requests, "request", "requests")} in ${codeSpan(started.http ?? "http.jsonl")}`] : []),
      ...(started.processes > 0 ? [countOf(started.processes, "process", "processes")] : []),
      ...((started.mcp ?? 0) > 0 ? [`${countOf(started.mcp!, "MCP call", "MCP calls")} in ${codeSpan("mcp.jsonl")}`] : []),
    ];
    if (parts.length > 0) items.push(`started after the step ended: ${parts.join(", ")}`);
  }
  for (const [late, what] of [
    [step.program_log_late, "log"],
    [step.events_late, "events"],
  ] as const) {
    if (late === undefined) continue;
    const lines = countOf(late.lines, "line", "lines");
    items.push(
      late.file === null
        ? `${lines} of the program's ${what} after the step ended, which could not be written`
        : `${lines} of the program's ${what} after the step ended, in ${codeSpan(late.file)}`,
    );
  }
  return items;
}

// Once per world, what of the program's log and execution events no
// step's record holds. A head step's late lines are its own entry, so the
// world names its late count only when it is the pattern a program that
// buffers its output on a pipe makes, or when the world is the base's or
// the old one, whose steps have no entries.
function worldLimits(world: RunWorld): RunLimit[] {
  const tree = world.tree ?? "head";
  const at = { environment: world.name, world: tree };
  const limits: RunLimit[] = [];
  const log = world.program_log;
  if (log === null) {
    limits.push({ kind: "unrecorded-log", ...at, detail: `not read, since the program runs at ${world.url ?? "a URL"}, which nukadoko did not start` });
  } else if (log !== undefined && log.stamped > 0) {
    if (log.tagged === 0) {
      limits.push({ kind: "unrecorded-log", ...at, detail: "carries no trace ids, so each step's slice of it is empty" });
    } else if (log.late > 0 && log.lines === 0) {
      limits.push({
        kind: "unrecorded-log",
        ...at,
        detail:
          `${countOf(log.late, "line", "lines")} carrying a step's trace id arrived after that step ended (${codeSpan("program-log-late.txt")}), and none in time, ` +
          "which is what a program that buffers its output on a pipe looks like",
        fix: "if that is the cause, set `STDOUT.sync = true` in Ruby, or `PYTHONUNBUFFERED=1` for Python",
      });
    } else if (log.late > 0 && tree !== "head") {
      limits.push({ kind: "unrecorded-log", ...at, detail: `${countOf(log.late, "line", "lines")} carrying a step's trace id arrived after that step ended (${codeSpan("program-log-late.txt")})` });
    }
  }
  const events = world.events;
  if (events === null) {
    limits.push({ kind: "unrecorded-events", ...at, detail: `not read, since the program runs at ${world.url ?? "a URL"}, which nukadoko did not start` });
  } else if (events !== undefined) {
    if (events.lines === 0) {
      limits.push({ kind: "unrecorded-events", ...at, detail: `the program wrote no line to the file ${codeSpan("{events}")} names, so no step's record has an event` });
    } else {
      const undefinedKinds = Object.entries(events.undefined_kinds);
      const facts = [
        ...(events.late > 0 && tree !== "head" ? [`${countOf(events.late, "line", "lines")} carrying a step's trace id arrived after that step ended (${codeSpan("events-late.jsonl")})`] : []),
        ...(events.unreadable > 0 ? [`${countOf(events.unreadable, "line is", "lines are")} not one readable line of the format`] : []),
        ...(undefinedKinds.length > 0
          ? [
              `${countOf(
                undefinedKinds.reduce((total, [, count]) => total + count, 0),
                "line names",
                "lines name",
              )} a kind the format does not define (${undefinedKinds.map(([kind]) => codeSpan(kind)).join(", ")})`,
            ]
          : []),
      ];
      if (facts.length > 0) {
        const copy = events.file === null ? "the world's copy of the file could not be written" : `the whole file is in ${codeSpan(events.file)}`;
        limits.push({ kind: "unrecorded-events", ...at, detail: `${facts.join("; ")}; ${copy}` });
      }
    }
  }
  return limits;
}
