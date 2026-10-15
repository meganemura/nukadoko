import type { Vocabulary } from "../discover/discover-steps.js";
import { parseFeatureSource } from "../feature/load-features.js";
import { deepEqual } from "../harvest/categorize-args.js";
import { renderPatternLine } from "../harvest/render-line.js";
import { bindStepArgs, matchPickleStep, type StepBinding } from "../run/match-step.js";
import { toStoredForm } from "../stored-form/stored-form.js";
import type { PlannedStep } from "./sequence.js";

// Responsibility: turn a sequence into a scenario a person can paste into
// a feature file. Each step becomes a `*` line from its first pattern, as
// `nuka harvest` writes one. Every line is then parsed and matched the way
// `nuka run` reads it, and a line that does not read back to the same step
// and args carries a comment saying so. An args key the line has no
// capture for is named in a comment too, because pasting the line would
// lose that value.

const STEP_INDENT = "    ";

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

function flatten(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

interface Line {
  readonly name: string;
  readonly text: string | undefined;
  readonly inline: Record<string, unknown>;
  readonly comments: string[];
}

function toLine(step: PlannedStep, vocabulary: Vocabulary): Line {
  const args = isPlainRecord(step.args) ? step.args : {};
  const entry = vocabulary.get(step.name);
  if (entry === undefined || entry.kind !== "typed" || entry.step.patterns.length === 0) {
    return {
      name: step.name,
      text: undefined,
      inline: {},
      comments: [`step "${step.name}" has no typed pattern to write as a line; args: ${JSON.stringify(step.args)}`],
    };
  }
  const rendered = renderPatternLine(entry.step.patterns[0]!, args);
  if (!rendered.ok) {
    return { name: step.name, text: undefined, inline: {}, comments: [flatten(rendered.message)] };
  }
  const captured = new Set(rendered.captures.map((capture) => capture.key));
  const inline: Record<string, unknown> = {};
  const comments: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (captured.has(key)) inline[key] = value;
    else comments.push(`args key "${key}" (value: ${JSON.stringify(value)}) has no capture on this line`);
  }
  return { name: step.name, text: rendered.text, inline, comments };
}

async function readBack(lines: readonly Line[], vocabulary: Vocabulary, bindings: readonly StepBinding[]): Promise<void> {
  const written = lines.filter((line): line is Line & { text: string } => line.text !== undefined);
  if (written.length === 0) return;
  const source = `Feature: read back\n  Scenario: read back\n${written.map((line) => `${STEP_INDENT}* ${line.text}\n`).join("")}`;
  let pickleSteps;
  try {
    pickleSteps = parseFeatureSource(source, "<nuka explore>").pickles[0]!.steps;
  } catch (error) {
    for (const line of written) {
      line.comments.push(`this scenario does not parse as Gherkin: ${flatten(error instanceof Error ? error.message : String(error))}`);
    }
    return;
  }
  for (const [index, line] of written.entries()) {
    const pickleStep = pickleSteps[index]!;
    const outcome = await matchPickleStep(pickleStep.text, bindings, null);
    if (outcome.kind !== "matched" || outcome.stepName !== line.name) {
      const readAs =
        outcome.kind === "matched"
          ? `step "${outcome.stepName}"`
          : outcome.kind === "ambiguous"
            ? `ambiguous between ${outcome.stepNames.join(", ")}`
            : "an undefined step";
      line.comments.push(`this line reads back as ${readAs}, not step "${line.name}"`);
      continue;
    }
    const entry = vocabulary.get(line.name)!;
    if (entry.kind !== "typed") continue;
    const bound = bindStepArgs(line.name, outcome.captures, outcome.values, pickleStep.argument, entry.step.args);
    const readArgs = bound.ok ? toStoredForm(bound.value) : undefined;
    const expected = toStoredForm(line.inline);
    if (!bound.ok || !deepEqual(readArgs, expected)) {
      line.comments.push(
        `this line reads back with args ${bound.ok ? JSON.stringify(readArgs) : flatten(bound.message)}, ` +
          `not ${JSON.stringify(expected)}`,
      );
    }
  }
}

/** The scenario as lines, each without its newline. */
export async function renderScenario(input: RenderScenarioInput): Promise<string[]> {
  const lines = input.steps.map((step) => toLine(step, input.vocabulary));
  await readBack(lines, input.vocabulary, input.bindings);
  const out = [`  Scenario: ${input.title}`];
  for (const [index, line] of lines.entries()) {
    const note = input.notes.get(index);
    if (note !== undefined) out.push(`${STEP_INDENT}# ${flatten(note)}`);
    for (const comment of line.comments) out.push(`${STEP_INDENT}# ${comment}`);
    if (line.text !== undefined) out.push(`${STEP_INDENT}* ${line.text}`);
  }
  return out;
}
