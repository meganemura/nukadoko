import type { PickleStep } from "@cucumber/messages";
import type { Vocabulary } from "../discover/discover-steps.js";
import { parseFeatureSource } from "../feature/load-features.js";
import { bindStepArgs, matchPickleStep, type StepBinding } from "../run/match-step.js";
import { toStoredForm } from "../stored-form/stored-form.js";
import { renderAttachmentBlock, type Attachment } from "./render-line.js";

// Responsibility: one scenario draft, the shape `nuka explore` prints.
// A caller turns each step into a `DraftEntry`:
// a rendered line with its table or docstring and the args it must read
// back to, or a comment when no line can be written. `readBack` then
// parses the whole draft once, through the same @cucumber/gherkin entry
// point `nuka run` uses, and matches and binds each line the way `nuka
// run` does. A line that does not return the same step and args gets a
// `roundTripFailure`. Parsing the assembled text, rather than building a
// PickleStepArgument by hand, is what exercises render-line.ts's own
// table and docstring escaping: a broken escape would never reach a
// parser that could catch it otherwise.
//
// This file does not decide which args key becomes a capture, a chain, or
// the attachment. That depends on where the args came from, which only
// the caller knows: for explore, a model's draw.

const STEP_INDENT = "    ";
const ATTACHMENT_INDENT = "      ";

export interface LineEntry {
  readonly kind: "line";
  readonly stepName: string;
  readonly text: string;
  readonly attachment?: Attachment;
  /** The args this line is responsible for, in stored form: its own
   * captures plus its attachment key. */
  readonly expectedInlineArgs: Record<string, unknown>;
  /** Comment lines written above the line. */
  readonly comments: readonly string[];
  /** Set by `readBack` when the line does not read back as written. */
  roundTripFailure?: string;
}

export interface NoLineEntry {
  readonly kind: "no-line";
  readonly stepName: string;
  /** The one comment written in place of a line. */
  readonly reason: string;
}

export type DraftEntry = LineEntry | NoLineEntry;

// Every CSI sequence (`ESC [ <params> <final byte>`) — colors and text
// styling included — is a display instruction for a terminal, not part of
// the message a reader or `.feature` file needs. Playwright's own "Call
// log:" text carries exactly this shape (dim/reset around each waited-for
// locator), and every message a draft carries is destined for a `.feature`
// comment or stderr, neither of which renders ANSI. A second pass drops any
// stray ESC byte that survives (a truncated or malformed sequence): the
// guarantee this makes is "no ESC reaches the output", not "every
// well-formed CSI sequence was recognized".
const ANSI_CSI_PATTERN = /\u001b\[[0-9;]*[a-zA-Z]/g;

/** One comment line: no terminal escapes, no line break. */
export function flatten(message: string): string {
  return message.replace(ANSI_CSI_PATTERN, "").replace(/\u001b/g, "").replace(/\s*\n\s*/g, " ");
}

export function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality over the JSON-safe values a step record's own
 * `args`/`result` are built from (string/number/boolean/null, plus arrays
 * and plain objects of the same) — never invoked on anything else, so this
 * does not need to handle `Date`, `Map`, or any other referenced type a
 * general-purpose deep-equal would. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** The block a value can be written as: a string is a docstring, a list of
 * string rows is a table, and anything else has no block. */
export function attachmentFor(key: string, value: unknown): Attachment | undefined {
  if (typeof value === "string") {
    return { kind: "docstring", key, value };
  }
  if (Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
    return { kind: "table", key, value: value as readonly (readonly string[])[] };
  }
  return undefined;
}

function renderEntryBody(entry: DraftEntry): string[] {
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

/** The scenario as lines, each without its newline. A note is one more
 * comment, above everything entry `index` writes. */
export function renderScenarioLines(
  title: string,
  entries: readonly DraftEntry[],
  notes: ReadonlyMap<number, string> = new Map(),
): string[] {
  return [
    `  Scenario: ${title}`,
    ...entries.flatMap((entry, index) => {
      const note = notes.get(index);
      return [...(note === undefined ? [] : [`${STEP_INDENT}# ${flatten(note)}`]), ...renderEntryBody(entry)];
    }),
  ];
}

async function describeMatchFailure(
  text: string,
  expectedStepName: string,
  bindings: readonly StepBinding[],
): Promise<string> {
  // No scenario World exists while a draft is being read back. `null` is
  // the same "nothing to bind" this function can offer a transformer.
  const outcome = await matchPickleStep(text, bindings, null);
  if (outcome.kind === "undefined") {
    return `wrote "${text}"; read back as an undefined step`;
  }
  if (outcome.kind === "ambiguous") {
    return `wrote "${text}"; read back as ambiguous between: ${outcome.stepNames.join(", ")}`;
  }
  return `wrote "${text}"; read back as step "${outcome.stepName}" instead of "${expectedStepName}"`;
}

/**
 * Parses the whole draft once (before any round-trip comment exists), then
 * re-matches and re-binds each line's own pickle step the way `nuka run`
 * would, setting `roundTripFailure` on each `LineEntry` that disagrees
 * with what its caller set out to write. `uri` names the draft in a parse
 * error.
 */
export async function readBack(
  entries: readonly DraftEntry[],
  vocabulary: Vocabulary,
  bindings: readonly StepBinding[],
  uri: string,
): Promise<void> {
  const lineEntries = entries.filter((entry): entry is LineEntry => entry.kind === "line");
  if (lineEntries.length === 0) {
    return;
  }

  const preText = `Feature: (name me)\n\n${renderScenarioLines("(name me)", entries).map((line) => `${line}\n`).join("")}`;
  let pickleSteps: readonly PickleStep[];
  try {
    const parsed = parseFeatureSource(preText, uri);
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

  for (const [index, entry] of lineEntries.entries()) {
    const pickleStep = pickleSteps[index]!;
    const outcome = await matchPickleStep(pickleStep.text, bindings, null);
    if (outcome.kind !== "matched" || outcome.stepName !== entry.stepName) {
      entry.roundTripFailure = `this line does not read back to the same step: ${await describeMatchFailure(pickleStep.text, entry.stepName, bindings)}`;
      continue;
    }
    const vocabularyEntry = vocabulary.get(entry.stepName);
    if (vocabularyEntry === undefined || vocabularyEntry.kind !== "typed") {
      entry.roundTripFailure = `this line's step "${entry.stepName}" is no longer a typed step in the current vocabulary`;
      continue;
    }
    const bound = bindStepArgs(
      entry.stepName,
      outcome.captures,
      outcome.values,
      pickleStep.argument,
      vocabularyEntry.step.args,
      new Set(Object.keys(vocabularyEntry.step.from)),
    );
    if (!bound.ok) {
      entry.roundTripFailure = `this line does not read back to the same args: ${flatten(bound.message)}`;
      continue;
    }
    // Expected args are in stored form (a bigint as its decimal string),
    // so the bound value is compared in that same form.
    const readArgs = toStoredForm(bound.value);
    if (!deepEqual(readArgs, entry.expectedInlineArgs)) {
      entry.roundTripFailure =
        `this line does not read back to the same args: wrote ${formatValue(entry.expectedInlineArgs)}; ` +
        `read back as ${formatValue(readArgs)}`;
    }
  }
}
