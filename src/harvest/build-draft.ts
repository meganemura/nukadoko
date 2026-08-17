import type { PickleStep } from "@cucumber/messages";
import { parseFeatureSource } from "../feature/load-features.js";
import type { StepRecord } from "../record/types.js";
import { bindStepArgs, matchPickleStep, type StepBinding } from "../run/match-step.js";
import type { Step } from "../step/define-step.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { categorizeArgs, deepEqual, toArgsRecord } from "./categorize-args.js";
import { renderAttachmentBlock, renderPatternLine, type Attachment } from "./render-line.js";

// Responsibility: turn one ordered list of step records into the feature
// draft `nuka harvest` prints and the notices it writes to stderr
// (docs/spec.md "Harvesting"). Three things happen per record, in this
// order: render its pattern's first entry into text (render-line.ts), sort
// its remaining args keys into chain/attachment/unfillable
// (categorize-args.ts), then read the *rendered* text back through the
// exact matching `nuka run` uses (src/run/match-step.ts) to confirm it
// lands on the same step with the same non-chain args — never a second
// implementation of that question, only ever this one call.
//
// The round trip parses the whole assembled draft once, through
// src/feature/load-features.ts's own `parseFeatureSource` — the same
// @cucumber/gherkin entry point `nuka run`/`nuka check` parse a real
// feature file through — rather than hand-building a PickleStepArgument for
// each table/docstring. That is what actually exercises render-line.ts's
// own escaping: a synthetic argument object would let a broken `\|`/`"""`
// escape pass unnoticed, since the bug would never reach a parser that
// could catch it.
//
// A record that cannot become a line at all (no pattern, not in the
// current vocabulary, a pattern that fails to parse) contributes a comment
// only, never a `*` line — the one case with nothing to round trip in the
// first place. "Same args" for the round trip means the args this exact
// line is responsible for (its own captures plus its own table/docstring
// key, if any) — never the keys left to chain, whose order `nuka check`'s
// own binding-order proof verifies instead (docs/spec.md "Harvesting").

export interface DraftInput {
  /** Step record ids, already ordered by `started_at` (docs/spec.md
   * "Harvesting": "the order it actually ran in"). */
  readonly orderedIds: readonly string[];
  readonly recordsById: ReadonlyMap<string, StepRecord>;
  readonly vocabulary: Vocabulary;
  readonly bindings: readonly StepBinding[];
}

export interface DraftResult {
  /** The full feature draft, `Feature:`/`Scenario:` placeholders included,
   * ending in a trailing newline. */
  readonly featureText: string;
  /** Provenance and every named anomaly, one entry per line, no trailing
   * newline on any of them. */
  readonly notices: readonly string[];
}

const STEP_INDENT = "    ";
const ATTACHMENT_INDENT = "      ";

function flatten(message: string): string {
  return message.replace(/\s*\n\s*/g, " ");
}

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildStepNameOf(vocabulary: Vocabulary): ReadonlyMap<Step, string> {
  const stepNameOf = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      stepNameOf.set(entry.step, entry.name);
    }
  }
  return stepNameOf;
}

interface NoLineEntry {
  readonly kind: "no-line";
  readonly recordId: string;
  readonly stepName: string;
  readonly reason: string;
}

interface LineEntry {
  readonly kind: "line";
  readonly recordId: string;
  readonly stepName: string;
  readonly text: string;
  readonly attachment?: Attachment;
  readonly expectedInlineArgs: Record<string, unknown>;
  readonly comments: readonly string[];
  /** Filled in by `runRoundTrip`; absent until then, and absent afterward
   * too when the line read back cleanly. */
  roundTripFailure?: string;
}

type Entry = NoLineEntry | LineEntry;

function buildEntry(
  recordId: string,
  record: StepRecord,
  vocabulary: Vocabulary,
  harvestedIds: ReadonlySet<string>,
  recordsById: ReadonlyMap<string, StepRecord>,
  stepNameOf: ReadonlyMap<Step, string>,
): Entry {
  const stepName = record.step;
  const entry = vocabulary.get(stepName);
  if (entry === undefined) {
    return {
      kind: "no-line",
      recordId,
      stepName,
      reason: `step "${stepName}" is not in the vocabulary this project discovers now; args: ${formatValue(record.args)}`,
    };
  }
  if (entry.kind !== "typed") {
    return {
      kind: "no-line",
      recordId,
      stepName,
      reason: `step "${stepName}" is a compat step now, with no pattern this could render as a typed line; args: ${formatValue(record.args)}`,
    };
  }
  if (entry.step.patterns.length === 0) {
    return {
      kind: "no-line",
      recordId,
      stepName,
      reason: `step "${stepName}" has no pattern to render as a line; args: ${formatValue(record.args)}`,
    };
  }

  const args = toArgsRecord(record);
  const rendered = renderPatternLine(entry.step.patterns[0]!, args);
  if (!rendered.ok) {
    return {
      kind: "no-line",
      recordId,
      stepName,
      reason: `step "${stepName}"'s pattern cannot become a line: ${flatten(rendered.message)}; args: ${formatValue(record.args)}`,
    };
  }

  const captureKeys = new Set(rendered.captures.map((capture) => capture.key));
  const categorized = categorizeArgs(entry.step, record, captureKeys, harvestedIds, recordsById, stepNameOf);

  const comments: string[] = [];
  if (record.status === "failed") {
    comments.push(`this record failed when it ran (${record.error.kind}): ${flatten(record.error.message)}`);
  }
  for (const [key, outside] of categorized.chainOutsideList) {
    comments.push(
      `args key "${key}" was read from step record ${outside.stepRecordId} (step "${outside.producerStep}"), ` +
        `which is not among the ids given to this harvest call; include it or fill "${key}" another way`,
    );
  }
  for (const { key, value } of categorized.unfillable) {
    comments.push(
      `args key "${key}" (value: ${formatValue(value)}) has no capture, no confirmed chain, and no docstring/table ` +
        `slot on this line; \`nuka check\` will report it as unfillable-required-key`,
    );
  }

  const expectedInlineArgs: Record<string, unknown> = {};
  for (const key of captureKeys) {
    expectedInlineArgs[key] = args[key];
  }
  if (categorized.attachment !== undefined) {
    expectedInlineArgs[categorized.attachment.key] = categorized.attachment.value;
  }

  return {
    kind: "line",
    recordId,
    stepName,
    text: rendered.text,
    attachment: categorized.attachment,
    expectedInlineArgs,
    comments,
  };
}

function renderEntryBody(entry: Entry): string[] {
  if (entry.kind === "no-line") {
    return [`${STEP_INDENT}# ${entry.reason}`];
  }
  const lines: string[] = entry.comments.map((comment) => `${STEP_INDENT}# ${comment}`);
  if (entry.roundTripFailure !== undefined) {
    lines.push(`${STEP_INDENT}# ${entry.roundTripFailure}`);
  }
  lines.push(`${STEP_INDENT}* ${entry.text}`);
  if (entry.attachment !== undefined) {
    lines.push(...renderAttachmentBlock(entry.attachment, ATTACHMENT_INDENT));
  }
  return lines;
}

function assembleFeatureText(entries: readonly Entry[]): string {
  const body = entries.flatMap((entry) => renderEntryBody(entry));
  return `Feature: (name me)\n\n  Scenario: (name me)\n${body.map((line) => `${line}\n`).join("")}`;
}

function describeMatchFailure(text: string, expectedStepName: string, bindings: readonly StepBinding[]): string {
  const outcome = matchPickleStep(text, bindings);
  if (outcome.kind === "undefined") {
    return `wrote "${text}"; read back as an undefined step`;
  }
  if (outcome.kind === "ambiguous") {
    return `wrote "${text}"; read back as ambiguous between: ${outcome.stepNames.join(", ")}`;
  }
  return `wrote "${text}"; read back as step "${outcome.stepName}" instead of "${expectedStepName}"`;
}

/**
 * The round trip this file's own header describes: parses the whole draft
 * once (`assembleFeatureText`, without any round-trip comment yet — none
 * exist before this runs), then re-matches and re-binds each rendered
 * line's own pickle step the same way `nuka run` would, mutating each
 * `LineEntry`'s `roundTripFailure` in place when it disagrees with what
 * `buildEntry` set out to write.
 */
function runRoundTrip(entries: readonly Entry[], bindings: readonly StepBinding[], vocabulary: Vocabulary): void {
  const lineEntries = entries.filter((entry): entry is LineEntry => entry.kind === "line");
  if (lineEntries.length === 0) {
    return;
  }

  const preText = assembleFeatureText(entries);
  let pickleSteps: readonly PickleStep[];
  try {
    const parsed = parseFeatureSource(preText, "<nuka harvest>");
    if (parsed.pickles.length !== 1) {
      throw new Error(`expected exactly one scenario, parsed ${parsed.pickles.length}`);
    }
    pickleSteps = parsed.pickles[0]!.steps;
  } catch (error) {
    const message = `this draft failed to parse as Gherkin: ${flatten(error instanceof Error ? error.message : String(error))}`;
    for (const entry of lineEntries) {
      entry.roundTripFailure = message;
    }
    return;
  }

  if (pickleSteps.length !== lineEntries.length) {
    const message = `this draft parsed into ${pickleSteps.length} step(s), not the ${lineEntries.length} rendered`;
    for (const entry of lineEntries) {
      entry.roundTripFailure = message;
    }
    return;
  }

  lineEntries.forEach((entry, index) => {
    const pickleStep = pickleSteps[index]!;
    const outcome = matchPickleStep(pickleStep.text, bindings);
    if (outcome.kind !== "matched" || outcome.stepName !== entry.stepName) {
      entry.roundTripFailure = `this line does not read back to the same step: ${describeMatchFailure(pickleStep.text, entry.stepName, bindings)}`;
      return;
    }
    const vocabularyEntry = vocabulary.get(entry.stepName);
    if (vocabularyEntry === undefined || vocabularyEntry.kind !== "typed") {
      entry.roundTripFailure = `this line's step "${entry.stepName}" is no longer a typed step in the current vocabulary`;
      return;
    }
    const bound = bindStepArgs(
      entry.stepName,
      outcome.captures,
      outcome.values,
      pickleStep.argument,
      vocabularyEntry.step.args,
    );
    if (!bound.ok) {
      entry.roundTripFailure = `this line does not read back to the same args: ${flatten(bound.message)}`;
      return;
    }
    if (!deepEqual(bound.value, entry.expectedInlineArgs)) {
      entry.roundTripFailure =
        `this line does not read back to the same args: wrote ${formatValue(entry.expectedInlineArgs)}; ` +
        `read back as ${formatValue(bound.value)}`;
    }
  });
}

export function buildDraft(input: DraftInput): DraftResult {
  const { orderedIds, recordsById, vocabulary, bindings } = input;
  const harvestedIds = new Set(orderedIds);
  const stepNameOf = buildStepNameOf(vocabulary);

  const entries: Entry[] = orderedIds.map((recordId) => {
    const record = recordsById.get(recordId)!;
    return buildEntry(recordId, record, vocabulary, harvestedIds, recordsById, stepNameOf);
  });

  runRoundTrip(entries, bindings, vocabulary);

  const featureText = assembleFeatureText(entries);

  const notices: string[] = [];
  for (const entry of entries) {
    notices.push(`${entry.recordId}\tstep="${entry.stepName}"`);
    if (entry.kind === "no-line") {
      notices.push(`${entry.recordId}: ${entry.reason}`);
      continue;
    }
    for (const comment of entry.comments) {
      notices.push(`${entry.recordId}: ${comment}`);
    }
    if (entry.roundTripFailure !== undefined) {
      notices.push(`${entry.recordId}: ${entry.roundTripFailure}`);
    }
  }

  return { featureText, notices };
}
