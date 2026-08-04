import type { Receipt } from "../receipt/types.js";
import type { ScenarioRecord } from "../run/record-types.js";

// Responsibility: render the acceptance record's markdown text (m4b-accept
// task spec's own "record file" section — the exact shape is that section's
// own worked example, reproduced here field for field). Pure string building
// only: every value this module needs (feature source, parsed feature name,
// the winning run's scenarios, each step's own receipt) is handed in
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
// `evidence` is stripped from every receipt before it is embedded (spec:
// strip the `evidence` key from the receipt before writing it): trace.zip and
// screenshots stay under `.nukadoko/`, never copied into a file meant to be
// committed. Nothing else about a receipt is touched — this module does not
// redact a second time (redaction already happened once, when the receipt
// was first written, src/cli/run.ts's own scenario/receipt pipeline).
//
// A "Declared vs observed" section is added now (accept-declared-vs-observed
// task spec) — every scenario's own receipts already carry both `mutates`
// (declared) and `observed` (measured), so the record can say, in one place
// at its own tail, which steps declared `mutates: false` but were measured
// making a write. It never changes whether `nuka accept` refuses (that stays
// cli/accept.ts's seven conditions, untouched) and never asserts the step is
// wrong — see renderDeclaredVsObserved's own comment for why.

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
 * the record itself and every receipt its steps reference, already read
 * from disk and already keyed by receipt id (src/report/receipts.ts's own
 * `readReceiptsForRecord` — reused, not reimplemented, per this task's
 * spec's own "don't touch" list extending in spirit to "don't duplicate an
 * existing reader either"). */
export interface AcceptedScenario {
  readonly record: ScenarioRecord;
  readonly receipts: ReadonlyMap<string, Receipt | null>;
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
  /** In the order they should appear in the record — cli/accept.ts sorts
   * ascending by `line` before calling this (this module does not
   * re-sort). */
  readonly scenarios: readonly AcceptedScenario[];
}

/** Thrown when a scenario this module was asked to render is missing a
 * receipt its own record says it should have — every scenario passed into
 * this function is expected to be `status: "passed"` (src/run/
 * record-types.ts: "passed only when every step passed", so every one of
 * its steps has a non-null receipt id), so this can only mean the receipt
 * was deleted or corrupted on disk after the run that wrote it. Not one of
 * the spec's seven named rejection conditions — those are all things a user
 * did (dirty tree, moved HEAD, ...); this is nukadoko's own state being
 * unexpectedly incomplete, reported the same way any other internal
 * inconsistency here would be: thrown, caught once, by cli/accept.ts. */
export class MissingReceiptError extends Error {
  constructor(scenarioId: string, stepText: string, receiptId: string | null) {
    super(
      receiptId === null
        ? `scenario ${scenarioId}, step "${stepText}": no receipt id even though the scenario is recorded as passed`
        : `scenario ${scenarioId}, step "${stepText}": receipt ${receiptId} could not be read from .nukadoko/receipts`,
    );
    this.name = "MissingReceiptError";
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
  lines.push("scenarios:");
  for (const { record } of options.scenarios) {
    lines.push(`  - name: ${yamlScalar(record.scenario)}`);
    lines.push(`    line: ${record.line}`);
    lines.push(`    scenario_id: ${record.scenario_id}`);
  }
  lines.push("---");
  return lines;
}

// A non-exhaustive ternary (`hook.type === "before" ? ... : ...`) is what
// let `"after_step"` silently render as "After hook" in the first place
// (t7-afterstep-consumers task spec, item 2's own bug report) — `switch` +
// a `never`-typed default is the fix: if `ScenarioHookRecord["type"]` ever
// grows a fourth value, this stops compiling instead of quietly mislabeling
// it the way the ternary did. `step_index` is folded into the label itself,
// not left to the JSON body below to explain, since a JSON body's own key
// order is not something a reader scanning headings should have to open to
// find "which step".
function hookLabel(hook: ScenarioRecord["hooks"][number]): string {
  switch (hook.type) {
    case "before":
      return "Before hook";
    case "after":
      return "After hook";
    case "after_step":
      return `AfterStep hook (step ${hook.step_index})`;
    default: {
      const exhaustive: never = hook.type;
      throw new Error(`nuka accept: unhandled hook type ${String(exhaustive)}`);
    }
  }
}

function renderHook(hook: ScenarioRecord["hooks"][number]): string[] {
  return ["", `#### ${hookLabel(hook)}`, "", "```json", JSON.stringify(hook, null, 2), "```"];
}

// Shared by renderStep and the "Declared vs observed" section below: both
// need the same step-to-receipt lookup, and both must fail the same way
// (MissingReceiptError) when a passed scenario's own record disagrees with
// what is actually on disk — one failure mode, one place it is checked.
function resolveReceipt(scenarioId: string, step: ScenarioRecord["steps"][number], receipts: ReadonlyMap<string, Receipt | null>): Receipt {
  if (step.receipt === null) {
    throw new MissingReceiptError(scenarioId, step.text, null);
  }
  const receipt = receipts.get(step.receipt);
  if (receipt === null || receipt === undefined) {
    throw new MissingReceiptError(scenarioId, step.text, step.receipt);
  }
  return receipt;
}

function renderStep(scenarioId: string, step: ScenarioRecord["steps"][number], receipts: ReadonlyMap<string, Receipt | null>): string[] {
  const receipt = resolveReceipt(scenarioId, step, receipts);
  // `evidence` is the one key this record deliberately never carries (this
  // file's own header) — every other field of the receipt, `evidence`
  // included in the destructure only to drop it, passes through untouched.
  const { evidence: _evidence, ...withoutEvidence } = receipt;
  return ["", `#### ${step.text}`, "", "```json", JSON.stringify(withoutEvidence, null, 2), "```"];
}

function renderScenarioSection(scenario: AcceptedScenario): string[] {
  const { record, receipts } = scenario;
  const lines: string[] = ["", `### ${record.scenario} (line ${record.line})`];
  for (const step of record.steps) {
    lines.push(...renderStep(record.scenario_id, step, receipts));
  }
  for (const hook of record.hooks) {
    lines.push(...renderHook(hook));
  }
  return lines;
}

/** One step whose own receipt declared `mutates: false` but was measured
 * making at least one write (accept-declared-vs-observed task spec, scope). */
interface DeclaredVsObservedMismatch {
  readonly scenarioName: string;
  readonly stepText: string;
  readonly writes: number;
}

/** Walks every accepted scenario's own steps once, sorting each into one of
 * three buckets a receipt's own `mutates` already answers: declared true
 * (never interesting here, matches its own claim), declared false and
 * observed writes (a mismatch), or `mutates: null` (a compat step, which has
 * no declaration to compare against at all — reconcile-declared-vs-measured
 * design doc's own "recommended" section, unresolved point 2: kept out of
 * the mismatch count rather than folded into "no mismatch", since "nothing
 * to compare" and "compared and matched" are different facts). */
function collectDeclaredVsObserved(scenarios: readonly AcceptedScenario[]): {
  mismatches: DeclaredVsObservedMismatch[];
  compatStepCount: number;
} {
  const mismatches: DeclaredVsObservedMismatch[] = [];
  let compatStepCount = 0;
  for (const { record, receipts } of scenarios) {
    for (const step of record.steps) {
      const receipt = resolveReceipt(record.scenario_id, step, receipts);
      if (receipt.mutates === null) {
        compatStepCount += 1;
        continue;
      }
      if (receipt.mutates === false && receipt.observed.http_writes > 0) {
        mismatches.push({ scenarioName: record.scenario, stepText: step.text, writes: receipt.observed.http_writes });
      }
    }
  }
  return { mismatches, compatStepCount };
}

// The record's own tail: one roll-up section rather than a note per
// scenario, since a per-scenario note is exactly what a reader scrolling
// past scenario after scenario misses. Always present, even with zero
// mismatches, so "compared, found nothing" stays distinguishable from
// "never compared at all" — the same reason `compatStepCount` stays
// distinguishable from a mismatch count of zero. Deliberately states only
// the raw fact (declared value, observed count) and never a verdict — a step
// reading over POST is expected to land here every time it is accepted, by
// design, for the same reason run-time `mutates` enforcement was dropped:
// the HTTP method is not a trustworthy signal of a write. So this section is
// a record, not an accusation.
function renderDeclaredVsObserved(scenarios: readonly AcceptedScenario[]): string[] {
  const { mismatches, compatStepCount } = collectDeclaredVsObserved(scenarios);
  const lines: string[] = ["", "## Declared vs observed", ""];

  if (mismatches.length === 0) {
    lines.push("No step declared `mutates: false` and was measured making a write.");
  } else {
    lines.push(
      "Steps that declared `mutates: false` and were measured making writes. This is a comparison, not a verdict: a step that reads over POST records writes by design.",
      "",
    );
    for (const mismatch of mismatches) {
      const writeWord = mismatch.writes === 1 ? "write" : "writes";
      lines.push(
        `- "${mismatch.stepText}" (scenario "${mismatch.scenarioName}"): declared mutates: false, observed ${mismatch.writes} ${writeWord}`,
      );
    }
  }

  if (compatStepCount > 0) {
    const stepWord = compatStepCount === 1 ? "step" : "steps";
    const verb = compatStepCount === 1 ? "has" : "have";
    lines.push("", `${compatStepCount} compat ${stepWord} ${verb} no \`mutates\` declaration to compare.`);
  }

  return lines;
}

export function renderAcceptanceRecord(options: RenderAcceptanceRecordOptions): string {
  const frontmatter = renderFrontmatter(options);

  const title = options.featureName ?? options.featurePath;
  const body: string[] = [
    "",
    `# ${title}: green at ${options.commit.slice(0, 7)}`,
    "",
    "## The scenario as it ran",
    "",
    "```gherkin",
    // Feature files always end in their own trailing newline; the fence's
    // own closing "```" on the next line already supplies that break, so
    // the source's own trailing newline is trimmed here to avoid a blank
    // line inside the fence.
    options.featureSource.replace(/\n$/, ""),
    "```",
    "",
    "## What the tool measured",
  ];

  for (const scenario of options.scenarios) {
    body.push(...renderScenarioSection(scenario));
  }

  body.push(...renderDeclaredVsObserved(options.scenarios));

  return `${[...frontmatter, ...body].join("\n")}\n`;
}
