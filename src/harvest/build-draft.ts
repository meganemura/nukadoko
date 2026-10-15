import type { Vocabulary } from "../discover/discover-steps.js";
import { flatten, formatValue, readBack, renderPatternLine, renderScenarioLines, type DraftEntry } from "../draft/index.js";
import type { StepRecord } from "../record/types.js";
import type { StepBinding } from "../run/match-step.js";
import type { Step } from "../step/define-step.js";
import { categorizeArgs, toArgsRecord } from "./categorize-args.js";

// Responsibility: turn one ordered list of step records into the feature
// draft `nuka harvest` prints and the notices it writes to stderr
// (docs/spec.md "Harvesting"). Three things happen per record, in this
// order: render its pattern's first entry into text (src/draft), sort
// its remaining args keys into chain/attachment/unfillable/omitted-measured
// (categorize-args.ts), then read the *rendered* text back through the
// round trip src/draft shares with `nuka explore`, which matches the way
// `nuka run` does, to confirm it lands on the same step with the same
// non-chain args.
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

function buildStepNameOf(vocabulary: Vocabulary): ReadonlyMap<Step, string> {
  const stepNameOf = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      stepNameOf.set(entry.step, entry.name);
    }
  }
  return stepNameOf;
}

/** A draft entry and the record it came from, for the notices. */
type Entry = DraftEntry & { readonly recordId: string };

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
    // Only an "external" record's step name comes from a hand-typed string
    // (recordStep's own `name` option); a "do"/"run" record's
    // step name always came from discovery itself, so a mismatch there has
    // some other cause and this hint would misdirect.
    const externalHint =
      record.kind === "external"
        ? ` (recordStep's "name" option must match the name discovery assigns to this step's file)`
        : "";
    return {
      kind: "no-line",
      recordId,
      stepName,
      reason: `step "${stepName}" is not in the vocabulary this project discovers now${externalHint}; args: ${formatValue(record.args)}`,
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
  for (const { key, value } of categorized.omittedMeasured) {
    // Not the unfillable-required-key sentence above: that finding is only
    // true for a required key. An optional key's absence is a valid
    // contract, so check stays silent, and this comment is the only place
    // the measured value is written down.
    comments.push(
      `args key "${key}" (value: ${formatValue(value)}) was measured and fits no capture, chain, or docstring/table on this line`,
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

function assembleFeatureText(entries: readonly Entry[]): string {
  return `Feature: (name me)\n\n${renderScenarioLines("(name me)", entries)
    .map((line) => `${line}\n`)
    .join("")}`;
}

export async function buildDraft(input: DraftInput): Promise<DraftResult> {
  const { orderedIds, recordsById, vocabulary, bindings } = input;
  const harvestedIds = new Set(orderedIds);
  const stepNameOf = buildStepNameOf(vocabulary);

  const entries: Entry[] = orderedIds.map((recordId) => {
    const record = recordsById.get(recordId)!;
    return buildEntry(recordId, record, vocabulary, harvestedIds, recordsById, stepNameOf);
  });

  await readBack(entries, vocabulary, bindings, "<nuka harvest>");

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
