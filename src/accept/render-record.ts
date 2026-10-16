import type { StepRecord } from "../record/types.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import {
  collectDeclaredVsObserved,
  renderDeclaredVsObserved,
  type DeclaredVsObserved,
} from "../report/summary/declared-vs-observed.js";
import { hookLabel } from "../report/summary/hook-label.js";

// Responsibility: render the acceptance record's markdown text (docs/spec.md
// "Sign-off"). Pure string building only: every value this module needs
// (feature source, parsed feature name,
// the winning run's scenarios, each step's own step record) is handed in
// already resolved — cli/accept.ts owns picking the run, checking git, and
// writing the result to disk; this module never touches the filesystem.
//
// Frontmatter is hand-rolled, not produced by a YAML library (project rule:
// no new dependency without the user's sign-off first, and nukadoko has
// none today) — `yamlScalar` below quotes a value only when a bare plain
// scalar would be ambiguous or unsafe (leading indicator character, an
// embedded "`: `", trailing/leading whitespace, a line break), which covers
// every value this record actually carries: a scenario's own free-text name
// is the one field a Gherkin author fully controls, so it is the one this
// module cannot assume is already "plain-scalar safe". `target_version` is
// always quoted regardless (matching the spec's own worked example) — a
// bare `2.4.0` is valid YAML but looks unpleasantly like it could be
// misread as a number, and quoting it costs nothing.
//
// An acceptance record carries a claim, "this scenario was green at commit
// X", not a transcript of everything a browser happened to do while proving
// it. What stays on a step or hook record embedded here is decided by one
// question: did the step's own contract name this field, or did a page
// decide it by what it happened to load? `args`/`result` answer to a step's
// own `returns` schema, so they stay; `actions`/`page_events` answer to
// nothing but the page, so they go. That question is enforced as an
// allowlist (`STEP_RECORD_ALLOWLIST`/`HOOK_RECORD_ALLOWLIST`, below), not a
// denylist of the fields known to be page-shaped: a field neither list has
// heard of yet is dropped by default, on the same reasoning an unrecognized
// permission should default to denied rather than granted. Every key this
// module actually drops from a given record is named once, in the one line
// under "## What the tool measured" — dropping a field silently would leave
// a reader with no way to learn it ever existed on the step record measured
// on disk.
//
// A "Declared vs observed" section (docs/spec.md "Sign-off") gives sign-off
// its own record of what the two step record fields, `mutates` (declared)
// and `observed` (measured), agree or disagree about — the reconciliation
// used to be entirely on a human reading raw step records, with no note
// anywhere of whether the two were ever even compared. It never changes
// whether `nuka accept` refuses (that stays the refusals in cli/accept.ts)
// and never asserts the step is wrong. See
// src/report/summary/declared-vs-observed.ts for why; the run summary
// renders the same section.
//
// A "Condition" section, and a frontmatter `browser:` line beside the
// existing `environment:` one, are added now (docs/spec.md "Sign-off") —
// what confirmed this run, stated once near the top rather than
// left implicit in the filename alone. `browser` is the accepted group's own
// measured engine (`browserRecord` in cli/accept.ts, never `config.
// browserType`): the literal string `"none"` in frontmatter, and an explicit
// "no browser was launched" sentence in the body, when nothing in the group
// launched one — never a blank line, so "condition unknown" (an older
// record, no `browser:` line at all — src/tend/record-parse.ts's own read
// side) stays distinguishable from "condition known: no browser". The body
// section carries the browser's *version* too, which frontmatter and the
// filename both deliberately don't: the engine's type is enough for
// acceptance, and the version is informational only.

function needsYamlQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/[\r\n]/.test(value)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (value.includes(": ") || value.endsWith(":")) return true;
  if (value.includes(" #")) return true;
  return false;
}

function yamlScalar(value: string): string {
  return needsYamlQuoting(value) ? JSON.stringify(value) : value;
}

/** One scenario this run accepted, plus everything its own section needs:
 * the record itself and every step record its steps reference, already read
 * from disk and already keyed by step record id (src/report/step-records.ts's
 * own `readStepRecordsForScenario` — reused here rather than reimplemented,
 * so there is only one reader of step records on disk). */
export interface AcceptedScenario {
  readonly record: ScenarioRecord;
  readonly stepRecords: ReadonlyMap<string, StepRecord | null>;
}

export interface RenderAcceptanceRecordOptions {
  /** Project-root-relative, same form as `ScenarioRecord.feature`. */
  readonly featurePath: string;
  /** The feature file's own raw text, read once by cli/accept.ts — copied
   * verbatim (spec: the tool copies the feature's full text itself, leaving
   * no room for a human to transcribe it by hand). */
  readonly featureSource: string;
  /** The parsed `Feature:` line's own name; falls back to the file's base
   * name only if gherkin somehow parsed a document with no `Feature:` name
   * at all (not reachable through cli/accept.ts's own parse step, which
   * would already have rejected an unparsable file, but a name is still
   * needed for the heading either way). */
  readonly featureName: string | undefined;
  /** Full 40-character sha, already confirmed to equal the current HEAD. */
  readonly commit: string;
  readonly runId: string;
  /** ISO 8601 — the accepted run's own start (this file's caller derives it
   * the same way src/accept/select-run.ts's own `runStartedAt` does: the
   * earliest `started_at` among the run's records). */
  readonly ranAt: string;
  /** ISO 8601 — when `nuka accept` itself ran. */
  readonly acceptedAt: string;
  readonly environment: string;
  readonly targetVersion: string | undefined;
  /** How many times each scenario ran in the accepted run: 1 for an
   * ordinary run, `n` for a `nuka run --repeat <n>` one. Above 1, the
   * record embeds each scenario's last execution and the Condition
   * section says so; the number is a condition of the sign-off (green
   * three times is a different claim from green once), so it lives beside
   * environment and browser rather than in a footnote. */
  readonly executionsPerScenario?: number;
  /** The accepted group's own measured browser condition (docs/spec.md
   * "Sign-off") — `undefined` when no scenario in the group
   * launched one at all. Never `config.browserType` itself (docs/spec.md
   * "Declaration and measurement answer different questions"): this is what
   * the group's own records measured, already filtered to match today's
   * config by cli/accept.ts before this function is ever called. */
  readonly browser: { readonly type: string; readonly version: string } | undefined;
  /** In the order they should appear in the record — cli/accept.ts sorts
   * ascending by `line` before calling this (this module does not
   * re-sort). */
  readonly scenarios: readonly AcceptedScenario[];
}

/** Thrown when a scenario this module was asked to render is missing a
 * step record its own record says it should have — every scenario passed
 * into this function is expected to be `status: "passed"` (src/record/
 * scenario-record.ts: `passed` only when every step passed, so every one of
 * its steps has a non-null step record id), so this can only mean the step
 * record was deleted or corrupted on disk after the run that wrote it. Not
 * one of the refusals cli/accept.ts applies to something a user did (a dirty
 * tree, a moved HEAD, and the rest listed there). This is nukadoko's own state
 * being unexpectedly incomplete, reported the same way any other internal
 * inconsistency here would be: thrown, caught once, by cli/accept.ts. */
export class MissingStepRecordError extends Error {
  constructor(scenarioId: string, stepText: string, recordId: string | null, stepsDir: string) {
    super(
      recordId === null
        ? `scenario ${scenarioId}, step "${stepText}": no step record id even though the scenario is recorded as passed`
        : `scenario ${scenarioId}, step "${stepText}": step record ${recordId} could not be read from ${stepsDir}`,
    );
    this.name = "MissingStepRecordError";
  }
}

function renderFrontmatter(options: RenderAcceptanceRecordOptions): string[] {
  const lines: string[] = ["---"];
  lines.push(`feature: ${yamlScalar(options.featurePath)}`);
  lines.push(`commit: ${options.commit}`);
  lines.push(`run_id: ${options.runId}`);
  lines.push(`ran_at: ${options.ranAt}`);
  lines.push(`accepted_at: ${options.acceptedAt}`);
  lines.push(`environment: ${yamlScalar(options.environment)}`);
  // Omitted entirely, not written as `null`, when the accepted run never
  // recorded one (spec: when target_version is absent from the record, omit
  // it from the frontmatter too).
  if (options.targetVersion !== undefined) {
    lines.push(`target_version: ${JSON.stringify(options.targetVersion)}`);
  }
  // Never omitted, unlike `target_version` just above (this file's own
  // header) — the literal `"none"` is what lets
  // src/tend/record-parse.ts's read side tell "this record predates the
  // condition concept" (line absent) apart from "this record's own
  // condition measured no browser" (line present, value `none`). The engine
  // name is always a bare, unquotable identifier (`BROWSER_ENGINES`'s own
  // keys), so `yamlScalar` is not needed here.
  lines.push(`browser: ${options.browser === undefined ? "none" : options.browser.type}`);
  lines.push("scenarios:");
  for (const { record } of options.scenarios) {
    lines.push(`  - name: ${yamlScalar(record.scenario)}`);
    lines.push(`    line: ${record.line}`);
    lines.push(`    scenario_record_id: ${record.scenario_record_id}`);
  }
  lines.push("---");
  return lines;
}

// The keep list for a step record embedded in the record body (this file's
// own header: contract-named, not page-shaped). `status`/`error` are here
// too, alongside `args`/`result`: a sign-off reader needs to know a step
// passed or failed and why, and neither is something a page decided on its
// own. Anything on a step record not named here — today that means
// `evidence`, `sections`, `calls`'s own trace-derived siblings `actions`/
// `truncated`, `polls`, `declared`, `page_events`, `http_omitted`, `http_log_failed` — is
// dropped by `pickAllowed` below and named in the record's own disclosure
// line, never passed through silently.
const STEP_RECORD_ALLOWLIST: ReadonlySet<string> = new Set([
  "step_record_id",
  "step",
  "kind",
  "status",
  "args",
  "result",
  "error",
  "used",
  "mutates",
  "observed",
  "calls",
  "fixtures",
  "required_env",
  "world",
  "started_at",
  "finished_at",
  "environment",
  "session",
  "session_execution",
  "scenario_record_id",
  "run_id",
  "target_version",
]);

// The same keep list for a hook record (`ScenarioHookRecord`,
// src/record/scenario-record.ts). A hook has no `args`/`result`/`observed` of its own (no
// step boundary to measure), so its own allowlist is shorter, but the same
// question decides it: `declared`/`trace`/`actions`/`truncated` all answer
// to what a page did during that one hook invocation, not to anything the
// hook itself was contracted to do.
const HOOK_RECORD_ALLOWLIST: ReadonlySet<string> = new Set(["type", "status", "error", "step_index", "name"]);

/** Keeps only the keys `allowlist` names, in the record's own key order
 * (`Object.entries` walks a plain object in insertion order, so the filtered
 * copy reads the same way the original `record.json` on disk does) —
 * every key dropped along the way is added to `strippedOut`, the running set
 * `renderAcceptanceRecord` turns into the record's own one-line disclosure
 * once every scenario has been walked. */
function pickAllowed(
  record: Record<string, unknown>,
  allowlist: ReadonlySet<string>,
  strippedOut: Set<string>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (allowlist.has(key)) {
      kept[key] = value;
    } else {
      strippedOut.add(key);
    }
  }
  return kept;
}

function renderHook(hook: ScenarioRecord["hooks"][number], strippedKeys: Set<string>): string[] {
  const kept = pickAllowed(hook as unknown as Record<string, unknown>, HOOK_RECORD_ALLOWLIST, strippedKeys);
  return ["", `#### ${hookLabel(hook)}`, "", "```json", JSON.stringify(kept, null, 2), "```"];
}

// Shared by renderStep and the "Declared vs observed" section below: both
// need the same step-to-step-record lookup, and both must fail the same way
// (MissingStepRecordError) when a passed scenario's own record disagrees
// with what is actually on disk — one failure mode, one place it is checked.
// The same location readStepRecordsForScenario reads from, so the message
// names the directory that was actually searched, whatever `stateDir` is.
function stepsDirOf(record: ScenarioRecord): string {
  return `${record.evidence.dir.replace(/[\\/][^\\/]+[\\/][^\\/]+$/, "")}/steps`;
}

function resolveStepRecord(
  record: ScenarioRecord,
  step: ScenarioRecord["steps"][number],
  stepRecords: ReadonlyMap<string, StepRecord | null>,
): StepRecord {
  if (step.step_record_id === null) {
    throw new MissingStepRecordError(record.scenario_record_id, step.text, null, stepsDirOf(record));
  }
  const stepRecord = stepRecords.get(step.step_record_id);
  if (stepRecord === null || stepRecord === undefined) {
    throw new MissingStepRecordError(record.scenario_record_id, step.text, step.step_record_id, stepsDirOf(record));
  }
  return stepRecord;
}

function renderStep(
  record: ScenarioRecord,
  step: ScenarioRecord["steps"][number],
  stepRecords: ReadonlyMap<string, StepRecord | null>,
  strippedKeys: Set<string>,
): string[] {
  const stepRecord = resolveStepRecord(record, step, stepRecords);
  const kept = pickAllowed(stepRecord as unknown as Record<string, unknown>, STEP_RECORD_ALLOWLIST, strippedKeys);
  return ["", `#### ${step.text}`, "", "```json", JSON.stringify(kept, null, 2), "```"];
}

/** One `| step | status | ms | mutates | reads | writes |` row per step, in
 * scenario order — the surface a reviewer actually reads, now that the JSON
 * blocks below it no longer carry the page-level detail a reviewer used to
 * scan them for. `ms` comes from the step record's own
 * `started_at`/`finished_at` (nothing else on the record times a step);
 * `mutates: null` (a compat step, no declaration to report) reads as
 * `compat` rather than the bare string `"null"`, matching the same three-way
 * distinction `renderDeclaredVsObserved` already draws. Omitted outright
 * for a scenario with no steps of its own (a hook-only scenario is not one
 * this build actually produces, but nothing this module reads guarantees
 * it): a table with a header and no rows would tell a reader less than no
 * table at all. */
function renderSummaryTable(
  record: ScenarioRecord,
  stepRecords: ReadonlyMap<string, StepRecord | null>,
): string[] {
  if (record.steps.length === 0) return [];
  const lines: string[] = [
    "",
    "| step | status | ms | mutates | reads | writes |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const step of record.steps) {
    const stepRecord = resolveStepRecord(record, step, stepRecords);
    const ms = Date.parse(stepRecord.finished_at) - Date.parse(stepRecord.started_at);
    const mutates = stepRecord.mutates === null ? "compat" : String(stepRecord.mutates);
    // A literal `|` inside a step's own text would otherwise be read as a
    // column boundary by any markdown table renderer; escaping it here is
    // the same "the source text can contain anything a Gherkin author
    // wrote" concern `yamlScalar` above exists for, just for table syntax
    // instead of YAML.
    const stepText = step.text.replace(/\|/g, "\\|");
    lines.push(
      `| ${stepText} | ${stepRecord.status} | ${ms} | ${mutates} | ${stepRecord.observed.http_reads} | ${stepRecord.observed.http_writes} |`,
    );
  }
  return lines;
}

function renderScenarioSection(scenario: AcceptedScenario, strippedKeys: Set<string>): string[] {
  const { record, stepRecords } = scenario;
  const lines: string[] = ["", `### ${record.scenario} (line ${record.line})`];
  lines.push(...renderSummaryTable(record, stepRecords));
  for (const step of record.steps) {
    lines.push(...renderStep(record, step, stepRecords, strippedKeys));
  }
  for (const hook of record.hooks) {
    lines.push(...renderHook(hook, strippedKeys));
  }
  return lines;
}

/** Every step of every accepted scenario, each resolved to its step record
 * the same strict way the tables above resolve them: an accepted scenario
 * passed, so a missing step record is corruption and throws. */
function comparedSteps(scenarios: readonly AcceptedScenario[]): DeclaredVsObserved {
  return collectDeclaredVsObserved(
    scenarios.flatMap(({ record, stepRecords }) =>
      record.steps.map((step) => ({
        scenarioName: record.scenario,
        stepText: step.text,
        stepRecord: resolveStepRecord(record, step, stepRecords),
      })),
    ),
  );
}

// Near the top, ahead of the scenario/step-record detail (docs/spec.md
// "Sign-off") — what confirmed this run is context a reader needs before
// the detail, not a footnote after it, the same reasoning that keeps
// "Declared vs observed" at the tail instead: that section is a roll-up
// computed *from* the detail above it, while this one is read *before* the
// detail to make sense of it at all. `environment` restates the frontmatter
// value in prose, deliberately: a reader of the rendered body should not
// have to open the frontmatter block to answer "what confirmed this".
function renderCondition(options: RenderAcceptanceRecordOptions): string[] {
  const lines: string[] = ["", "## Condition", "", `- environment: ${options.environment}`];
  lines.push(
    options.browser === undefined
      ? "- browser: not launched (no step in this run destructured page/context)"
      : `- browser: ${options.browser.type} ${options.browser.version}`,
  );
  if (options.executionsPerScenario !== undefined && options.executionsPerScenario > 1) {
    lines.push(
      `- repeat: each scenario ran ${options.executionsPerScenario} times in this run (nuka run --repeat), ` +
        "every execution green; the last one is embedded below",
    );
  }
  // The count, up front; the list stays at the tail (this function's own
  // comment above). A reviewer of a record with several scenarios reads
  // the Condition and the summary tables and may never reach the last
  // section, and that section is the only place a step's declaration is
  // set against what was measured. The number here is what tells them
  // whether the tail is worth scrolling to.
  const { mismatches } = comparedSteps(options.scenarios);
  lines.push(
    mismatches.length === 0
      ? "- declared vs observed: no step declared `mutates: false` and was measured making a write"
      : `- declared vs observed: ${mismatches.length} step${mismatches.length === 1 ? "" : "s"} declared ` +
          `\`mutates: false\` and ${mismatches.length === 1 ? "was" : "were"} measured making writes; listed at the end`,
  );
  return lines;
}

/** The record's own disclosure of what it left out — every key `pickAllowed`
 * actually dropped from a step or hook record embedded below, named once
 * rather than left for a reader to notice was missing. A field dropped
 * without being named would look as if the step record had never carried
 * it. Alphabetical and comma-separated so the line reads the
 * same regardless of which scenario happened to be the one that carried a
 * given field first. Omitted outright when nothing was stripped — a
 * disclosure with nothing to disclose would end in a bare colon, which says
 * less than no line at all. */
function renderStrippedKeysLine(strippedKeys: ReadonlySet<string>): string[] {
  if (strippedKeys.size === 0) return [];
  const keys = [...strippedKeys].sort().join(", ");
  return [
    "",
    `Evidence fields are stripped from every record below: ${keys}. They stay under the state directory with the trace and the screenshots, and are not committed.`,
  ];
}

export function renderAcceptanceRecord(options: RenderAcceptanceRecordOptions): string {
  const frontmatter = renderFrontmatter(options);

  // Collected before the disclosure line is written: the line names every
  // key any scenario's step or hook records actually carried and lost,
  // which is only known once every scenario has been walked.
  const strippedKeys = new Set<string>();
  const scenarioSections: string[] = [];
  for (const scenario of options.scenarios) {
    scenarioSections.push(...renderScenarioSection(scenario, strippedKeys));
  }

  const title = options.featureName ?? options.featurePath;
  // Longer than any backtick run in the source, so a doc string holding a
  // fence cannot close this one early.
  const longestRun = Math.max(0, ...(options.featureSource.match(/`+/g) ?? []).map((run) => run.length));
  const featureFence = "`".repeat(Math.max(3, longestRun + 1));
  const body: string[] = [
    "",
    `# ${title}: green at ${options.commit.slice(0, 7)}`,
    ...renderCondition(options),
    "",
    "## The scenario as it ran",
    "",
    `${featureFence}gherkin`,
    // Feature files always end in their own trailing newline; the fence's
    // own closing "```" on the next line already supplies that break, so
    // the source's own trailing newline is trimmed here to avoid a blank
    // line inside the fence.
    options.featureSource.replace(/\n$/, ""),
    featureFence,
    "",
    "## What the tool measured",
    ...renderStrippedKeysLine(strippedKeys),
    ...scenarioSections,
  ];

  body.push(...renderDeclaredVsObserved(comparedSteps(options.scenarios)));

  return `${[...frontmatter, ...body].join("\n")}\n`;
}
