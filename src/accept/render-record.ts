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

function renderHook(hook: ScenarioRecord["hooks"][number]): string[] {
  const label = hook.type === "before" ? "Before hook" : "After hook";
  return ["", `#### ${label}`, "", "```json", JSON.stringify(hook, null, 2), "```"];
}

function renderStep(scenarioId: string, step: ScenarioRecord["steps"][number], receipts: ReadonlyMap<string, Receipt | null>): string[] {
  if (step.receipt === null) {
    throw new MissingReceiptError(scenarioId, step.text, null);
  }
  const receipt = receipts.get(step.receipt);
  if (receipt === null || receipt === undefined) {
    throw new MissingReceiptError(scenarioId, step.text, step.receipt);
  }
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

export function renderAcceptanceRecord(options: RenderAcceptanceRecordOptions): string {
  const frontmatter = renderFrontmatter(options);

  const title = options.featureName ?? options.featurePath;
  const body: string[] = [
    "",
    `# ${title} — green at ${options.commit.slice(0, 7)}`,
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

  return `${[...frontmatter, ...body].join("\n")}\n`;
}
