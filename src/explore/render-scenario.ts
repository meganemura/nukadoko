import { asObjectShape, unconsumedRequiredKeys } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import {
  attachmentFor,
  flatten,
  formatValue,
  readBack,
  renderPatternLine,
  renderScenarioLines,
  type DraftEntry,
} from "../draft/index.js";
import type { StepBinding } from "../run/match-step.js";
import { toStoredForm } from "../stored-form/stored-form.js";
import type { PlannedStep } from "./sequence.js";

// Responsibility: turn a sequence into the entries of a scenario draft.
// Each step becomes a `*` line from its first pattern. The one required
// args key that no capture and no `from` speaks for becomes a table or a
// docstring, as `nuka run` would bind it. Any other key the line cannot
// carry is named in a comment, because pasting the line would lose that
// value. Rendering and the read-back are src/draft's.

export interface RenderScenarioInput {
  readonly title: string;
  readonly steps: readonly PlannedStep[];
  /** A comment placed on the line above step `index`. */
  readonly notes: ReadonlyMap<number, string>;
  readonly vocabulary: Vocabulary;
  readonly bindings: readonly StepBinding[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEntry(step: PlannedStep, vocabulary: Vocabulary): DraftEntry {
  const stored = toStoredForm(step.args);
  const args = isPlainRecord(stored) ? stored : {};
  const noLine = (reason: string): DraftEntry => ({ kind: "no-line", stepName: step.name, reason });
  const entry = vocabulary.get(step.name);
  if (entry === undefined || entry.kind !== "typed" || entry.step.patterns.length === 0) {
    return noLine(`step "${step.name}" has no typed pattern to write as a line; args: ${formatValue(stored)}`);
  }
  const rendered = renderPatternLine(entry.step.patterns[0]!, args);
  if (!rendered.ok) {
    return noLine(`step "${step.name}"'s pattern cannot become a line: ${flatten(rendered.message)}; args: ${formatValue(stored)}`);
  }
  const captured = new Set(rendered.captures.map((capture) => capture.key));
  const shape = asObjectShape(entry.step.args);
  const open =
    shape === undefined ? [] : unconsumedRequiredKeys(shape, new Set([...captured, ...Object.keys(entry.step.from)]));
  const attachment = open.length === 1 && open[0]! in args ? attachmentFor(open[0]!, args[open[0]!]) : undefined;

  const expectedInlineArgs: Record<string, unknown> = {};
  const comments: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (captured.has(key)) expectedInlineArgs[key] = value;
    else if (key === attachment?.key) expectedInlineArgs[key] = value;
    else comments.push(`args key "${key}" (value: ${formatValue(value)}) has no capture on this line`);
  }
  return { kind: "line", stepName: step.name, text: rendered.text, attachment, expectedInlineArgs, comments };
}

/** The scenario as lines, each without its newline. */
export async function renderScenario(input: RenderScenarioInput): Promise<string[]> {
  const entries = input.steps.map((step) => toEntry(step, input.vocabulary));
  await readBack(entries, input.vocabulary, input.bindings, "<nuka explore>");
  return renderScenarioLines(input.title, entries, input.notes);
}
