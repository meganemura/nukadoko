import { z } from "zod";
import { ConfigError } from "../config/errors.js";
import { loadConfig } from "../config/load-config.js";
import {
  discoverSteps,
  type Vocabulary,
  type VocabularyEntry,
} from "../discover/discover-steps.js";
import { DuplicateCompatStepError, DuplicateStepError } from "../discover/errors.js";

// Responsibility: the one path both `nuka steps` and `nuka describe` share —
// load the project's config, then discover its vocabulary. Kept out of
// run-cli.ts so that path is unit-testable without going through yargs.
// `discoverSteps` also returns compat-origin parameter type registrations
// (m2a-compat-registry task spec) — irrelevant to `steps`/`describe`, which
// only ever list/describe the step vocabulary itself, so this module drops
// that half of the result. `formatVocabulary` below is `nuka steps`' non-JSON
// rendering, also kept here as a pure function (steps-human-output task
// spec) — `run-cli.ts`'s handler passes a `WritableSink`, which can't answer
// "how wide is the terminal", so the width this function wraps to is
// resolved by the caller and passed in as a plain number.

export async function loadVocabulary(rootDir: string): Promise<Vocabulary> {
  const config = await loadConfig(rootDir);
  const { vocabulary } = await discoverSteps(rootDir, config.featuresDir);
  return vocabulary;
}

/**
 * `nuka steps`' one row per vocabulary entry. `kind` is always present
 * (this task's spec, item 5: `kind` is always shown); `description`/`mutates` are
 * present only for a typed entry — a compat entry has neither (no
 * declaration exists to show), and are omitted entirely from `--json`
 * output rather than serialized as `null` (optional fields simply aren't
 * there when `undefined`).
 */
export interface StepSummary {
  readonly name: string;
  readonly kind: "typed" | "compat";
  readonly patterns: readonly string[];
  readonly description?: string;
  readonly mutates?: boolean;
}

export function summarize(entry: VocabularyEntry): StepSummary {
  if (entry.kind === "compat") {
    return {
      name: entry.name,
      kind: "compat",
      patterns: [entry.compat.patternSource],
    };
  }
  return {
    name: entry.name,
    kind: "typed",
    patterns: entry.step.patterns,
    description: entry.step.description,
    mutates: entry.step.mutates,
  };
}

/**
 * `nuka steps`' non-JSON rendering: one block per entry, blank-line
 * separated, no trailing blank line (steps-human-output task spec). A
 * one-line-per-step tab-separated table was the previous shape, but real
 * vocabularies run 120-145 characters a line — unreadable once an 80-column
 * terminal soft-wraps it with no indentation to say where a row starts.
 * `--json` is the machine-readable path (docs/spec.md "CLI summary"); this
 * function only has to read well in a terminal, so it wraps to `width`
 * instead.
 */
export function formatVocabulary(summaries: readonly StepSummary[], width: number): string {
  if (summaries.length === 0) return "";
  return `${summaries.map((s) => formatVocabularyEntry(s, width)).join("\n\n")}\n`;
}

// Continuation-line indent (4) is one deeper than a pattern/description
// line's own indent (2) so a reader can tell "this line is still part of the
// item above" from "this is a new item's pattern/description line" without
// re-reading the content.
const ENTRY_INDENT = 2;
const CONTINUATION_INDENT = 4;

function formatVocabularyEntry(s: StepSummary, width: number): string {
  if (s.kind === "compat") {
    // No pattern line for compat: `name` already *is* `compat: <patternSource>`
    // (see `summarize` above), so printing the pattern too would repeat the
    // same string twice. No mutates label either — a compat step has no
    // declaration to read one from.
    return `${s.name}  compat`;
  }
  const mutatesLabel = s.mutates ? "mutates" : "read-only";
  const lines = [`${s.name}  ${s.kind}  ${mutatesLabel}`];
  const patterns = s.patterns.length > 0 ? s.patterns : ["(no pattern)"];
  for (const pattern of patterns) {
    lines.push(...wrapIndented(pattern, width));
  }
  if (s.description !== undefined) {
    lines.push(...wrapIndented(s.description, width));
  }
  return lines.join("\n");
}

/**
 * Wraps `text` at space boundaries only — a pattern is a cucumber-expression
 * or regex and a description is free-form prose, and splitting either mid-
 * word would make it uncopyable as the literal thing it names. A single word
 * wider than `width` is left on its own line unsplit for the same reason
 * (this task's spec: the terminal's own wrapping is the fallback, not this
 * function's job to improve on).
 */
function wrapIndented(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  let indent = ENTRY_INDENT;
  for (const word of text.split(" ")) {
    const candidate = current === "" ? `${" ".repeat(indent)}${word}` : `${current} ${word}`;
    if (current !== "" && candidate.length > width) {
      lines.push(current);
      indent = CONTINUATION_INDENT;
      current = `${" ".repeat(indent)}${word}`;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

// Not `ReturnType<typeof z.toJSONSchema>`: that function is overloaded (a
// single-schema form and a registry form), and TS resolves ReturnType of an
// overloaded function to its *last* signature — the registry one, whose
// `{ schemas: ... }` shape is not what a single `z.toJSONSchema(schema)`
// call returns. A plain JSON-Schema-shaped record avoids depending on that
// resolution; the CLI only ever JSON.stringifies this value.
export type JsonSchema = Record<string, unknown>;

export interface TypedStepContract {
  readonly kind: "typed";
  readonly name: string;
  readonly patterns: readonly string[];
  readonly description: string;
  readonly mutates: boolean;
  /** Why this step is implemented this way, and what was rejected
   * (`defineStep`'s own `rationale`) — present only when the step declared
   * one (t2-rationale task spec, item 3: omitted, not an empty string, same
   * convention as `used` on a receipt). Deliberately absent from
   * `StepSummary`/`summarize` below — `nuka steps` stays one line per step. */
  readonly rationale?: string;
  readonly args: JsonSchema;
  readonly returns: JsonSchema;
}

/**
 * `nuka describe` on a compat entry (this task's spec, item 5): no schema
 * exists to show, so this shape says so explicitly instead of a StepContract
 * with holes in it — `pattern` names what would need a `defineStep` to gain
 * a contract, and `message` states that plainly (docs/spec.md "What compat
 * steps lack").
 */
export interface CompatStepContract {
  readonly kind: "compat";
  readonly name: string;
  readonly pattern: string;
  readonly message: string;
}

export type StepContract = TypedStepContract | CompatStepContract;

export function describeContract(entry: VocabularyEntry): StepContract {
  if (entry.kind === "compat") {
    return {
      kind: "compat",
      name: entry.name,
      pattern: entry.compat.patternSource,
      message:
        'compat steps have no type contract; promote this pattern to defineStep to add one (docs/spec.md "What compat steps lack")',
    };
  }
  return {
    kind: "typed",
    name: entry.name,
    patterns: entry.step.patterns,
    description: entry.step.description,
    mutates: entry.step.mutates,
    // `rationale` is `string | undefined` on `Step`; `JSON.stringify` drops
    // an `undefined`-valued key on its own, so a step with none simply has
    // no "rationale" key in the output (t2-rationale task spec, item 3).
    rationale: entry.step.rationale,
    args: z.toJSONSchema(entry.step.args),
    returns: z.toJSONSchema(entry.step.returns),
  };
}

/**
 * Renders any error this CLI can encounter while loading a project's
 * vocabulary into a single line safe to print to stderr. ConfigError,
 * DuplicateStepError, and DuplicateCompatStepError already carry a complete,
 * specific message; anything else (e.g. a syntax error thrown by importing a
 * broken step file) falls back to its own message.
 */
export function formatVocabularyError(error: unknown): string {
  if (
    error instanceof ConfigError ||
    error instanceof DuplicateStepError ||
    error instanceof DuplicateCompatStepError
  ) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
