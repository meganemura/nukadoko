import { z } from "zod";
import { ConfigError } from "../config/errors.js";
import { loadConfig } from "../config/load-config.js";
import type { NukadokoConfig } from "../config/schema.js";
import {
  discoverSteps,
  type Vocabulary,
  type VocabularyEntry,
} from "../discover/discover-steps.js";
import { DuplicateCompatStepError, DuplicateStepError } from "../discover/errors.js";
import { buildFixtureGraph, type FixtureGraph } from "../fixture/graph.js";
import { fromCandidates, type Step, type StepFromMap } from "../step/define-step.js";
import { stepNeeds } from "../step/step-needs.js";

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
//
/** Also returns `config` (P5 task spec, scope item 11) — `nuka steps
 * --json`'s own `needs_browser` now needs the fixture dependency graph
 * (`buildFixtureGraph(config)`) to compute its transitive closure through
 * `config.fixtures`, and building that graph needs `config` itself.
 * `describe`'s own handler simply ignores this second field, unchanged. */
export async function loadVocabulary(
  rootDir: string,
): Promise<{ readonly vocabulary: Vocabulary; readonly config: NukadokoConfig }> {
  const config = await loadConfig(rootDir);
  const { vocabulary } = await discoverSteps(rootDir, config.featuresDir);
  return { vocabulary, config };
}

// `StepNames` (m6a-from-core task spec, item 7): a step's own `from` field
// (src/step/define-step.ts's `StepFromMap`) names its upstream by the `Step`
// object itself, never by name — the same identity-over-name choice
// `ctx.resultOf` makes, and for the same reason (docs/spec.md "Chaining
// steps"). Rendering `from` for `nuka steps --json`/`nuka describe` still
// has to show a *name* ("projectId" ← "create-project.id"), which only
// exists at discovery time. `summarize`/`describeContract` below take one
// `VocabularyEntry` at a time, never the whole `Vocabulary`, so neither can
// resolve an upstream Step's name from its own argument alone — hence this
// second, required parameter, built once per command by `buildStepNames`
// below and threaded through. A previous version of this module kept that
// lookup in a module-level `WeakMap`, populated as a `loadVocabulary` side
// effect: that made a caller's *order* (load, then summarize) load-bearing
// in a way neither type signature said, and left "(unregistered step)"
// ambiguous between "really never discovered" and "just called before that
// side effect ran" (m6d-vocabulary-name-lookup task spec). Passing the
// lookup as an argument makes forgetting it a compile error instead.
export type StepNames = ReadonlyMap<Step, string>;

/** Builds the {@link StepNames} lookup `summarize`/`describeContract` need,
 * from the same `Vocabulary` `loadVocabulary` already returned — one entry
 * per typed step (a compat entry has no `Step` object to key by). */
export function buildStepNames(vocabulary: Vocabulary): StepNames {
  const names = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      names.set(entry.step, entry.name);
    }
  }
  return names;
}

/** `"(unregistered step)"` when `stepNames` has no name for `step` — with
 * `stepNames` passed in by the caller (rather than populated as a side
 * effect this function reads later), this can now only mean one thing:
 * `from` names a Step the `Vocabulary` `stepNames` was built from never
 * discovered (docs/spec.md "Chaining steps"' own unregistered-Step
 * mistake). */
function upstreamStepName(step: Step, stepNames: StepNames): string {
  return stepNames.get(step) ?? "(unregistered step)";
}

/** One candidate producer, rendered for `nuka steps --json` — `fromSummary`
 * below emits one of these directly for a single-candidate key (unchanged
 * shape, m6a-from-core) or an array of them for a multi-candidate key (m7a-
 * from-alternatives task spec, item 5): the array-vs-object distinction
 * itself is how a reader tells a key with one candidate from a key with
 * several, without a separate count field. */
interface FromCandidateSummary {
  readonly step: string;
  readonly key: string;
}

/** `nuka steps --json`'s own rendering of a step's `from` (this task's spec,
 * item 7; multi-candidate shape added by m7a-from-alternatives task spec,
 * item 5) — one entry per key, `undefined` (hence omitted, `rationale`'s own
 * convention) when the step declares no `from` at all. A key with exactly
 * one candidate keeps the pre-m7a `{ step, key }` object shape untouched
 * (existing output for existing steps does not change); a key with more than
 * one is an array of that same shape, `[{ step, key }, ...]` — deliberately
 * not always-an-array, so a consumer written against the single-candidate
 * shape before this task keeps working, and a reader can tell "one
 * candidate" from "several" by checking `Array.isArray` (or simply
 * `.length`) without a separate field either way. */
function fromSummary(
  from: StepFromMap,
  stepNames: StepNames,
): Record<string, FromCandidateSummary | readonly FromCandidateSummary[]> | undefined {
  const entries = Object.entries(from);
  if (entries.length === 0) {
    return undefined;
  }
  const result: Record<string, FromCandidateSummary | readonly FromCandidateSummary[]> = {};
  for (const [key, entry] of entries) {
    const candidates = fromCandidates(entry).map(
      ([upstream, upstreamKey]): FromCandidateSummary => ({
        step: upstreamStepName(upstream, stepNames),
        key: upstreamKey,
      }),
    );
    result[key] = candidates.length === 1 ? candidates[0]! : candidates;
  }
  return result;
}

/** `nuka describe`'s own rendering of a step's `from` (this task's spec,
 * item 7) — one human-readable "step.key" string per key, the same "arrow"
 * shape docs/spec.md "Chaining steps" itself uses in prose
 * ("`projectId` ← `createProject.id`"), deliberately different from
 * `fromSummary`'s more structured shape above: `nuka describe` is the one
 * command meant for a person to read directly, `nuka steps --json` the one
 * meant for a program to parse. `undefined` (hence omitted) under the same
 * condition as `fromSummary`. A key with more than one candidate (m7a-from-
 * alternatives task spec, item 5) reads as "either of A or B" — spelled out
 * so a person skimming `nuka describe` sees the "exactly one of these, never
 * both" relationship the JSON form only implies through array length. */
function fromHumanReadable(from: StepFromMap, stepNames: StepNames): Record<string, string> | undefined {
  const entries = Object.entries(from);
  if (entries.length === 0) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of entries) {
    const candidates = fromCandidates(entry).map(
      ([upstream, upstreamKey]) => `${upstreamStepName(upstream, stepNames)}.${upstreamKey}`,
    );
    result[key] = candidates.length === 1 ? candidates[0]! : `either of ${candidates.join(" or ")}`;
  }
  return result;
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
  /** The fixture names this step's own `run()` destructures, alphabetized
   * (p4b-steps-needs task spec, `src/step/step-needs.ts`'s `stepNeeds`) —
   * present and possibly `[]` for a typed entry (a step that needs no
   * fixtures still gets the key, so "no needs" reads differently from "not
   * a typed entry", which omits it, the same convention `mutates` already
   * follows), absent entirely for a compat entry (no `run()` exists to
   * read). Not repeated in `formatVocabulary`'s text rendering below (this
   * task's spec: the full list is a `--json` concern, the text output only
   * marks `needsBrowser`). */
  readonly needs?: readonly string[];
  /** Whether this step's own fixture needs open a browser (`page` or
   * `context` among `needs`, `stepNeeds`'s own doc comment explains why
   * that check will need to widen once a user-defined fixture exists) —
   * lets an agent see, before running anything, which scenarios never open
   * one at all. Same presence rule as `needs`: present for every typed
   * entry, absent for a compat one. JSON key is `needs_browser`, not
   * `needsBrowser` (this project's own snake_case convention for a
   * `--json` field, matching `receipt.json`'s `waited_ms`/`http_reads`). */
  readonly needs_browser?: boolean;
  /** Where each declared args key not left to a pattern capture comes from
   * (m6a-from-core task spec, item 7) — key → `{ step, key }`, the upstream
   * step's own name and the `returns` key read from it, or (m7a-from-
   * alternatives task spec, item 5) an array of that same shape when the key
   * lists more than one mutually exclusive candidate producer. Absent for a
   * compat entry (no declaration exists) and omitted entirely, like
   * `mutates`, rather than serialized as `{}`, when a typed step declares no
   * `from` at all. Deliberately absent from `formatVocabulary`'s text
   * rendering below — `nuka steps` (non-JSON) stays one line per step, an
   * existing decision this task does not revisit. */
  readonly from?: Record<string, { step: string; key: string } | ReadonlyArray<{ step: string; key: string }>>;
}

/** `graph` (P5 task spec, scope item 11) is optional so every call site
 * that has no config-derived fixture graph handy keeps working unchanged
 * (`needs_browser` falls back to `stepNeeds`'s own direct membership
 * check) — `nuka steps --json`'s own handler (run-cli.ts) is the one
 * caller that builds and passes one. */
export function summarize(entry: VocabularyEntry, stepNames: StepNames, graph?: FixtureGraph): StepSummary {
  if (entry.kind === "compat") {
    return {
      name: entry.name,
      kind: "compat",
      patterns: [entry.compat.patternSource],
    };
  }
  const { needs, needsBrowser } = stepNeeds(entry.step, graph);
  return {
    name: entry.name,
    kind: "typed",
    patterns: entry.step.patterns,
    description: entry.step.description,
    mutates: entry.step.mutates,
    needs,
    needs_browser: needsBrowser,
    from: fromSummary(entry.step.from, stepNames),
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
  // `needs` itself (the full destructured-name list) stays out of this text
  // rendering on purpose (this task's spec: "needs の全列挙はテキスト側に
  // 出さない", `--json` is where a reader gets the list); `needs_browser`
  // gets a single word, appended only when true, the same "mark the fact,
  // say nothing when there's nothing to say" choice `compat` above already
  // makes for a step with no declaration at all.
  const browserLabel = s.needs_browser ? "  browser" : "";
  const lines = [`${s.name}  ${s.kind}  ${mutatesLabel}${browserLabel}`];
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
  /** Human-readable rendering of `from` (m6a-from-core task spec, item 7) —
   * `fromHumanReadable`'s own doc comment explains the "step.key" shape and
   * why it differs from `StepSummary.from`'s more structured one. Omitted,
   * not `{}`, when the step declares no `from` at all — same convention as
   * `rationale` just above. */
  readonly from?: Record<string, string>;
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

export function describeContract(entry: VocabularyEntry, stepNames: StepNames): StepContract {
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
    from: fromHumanReadable(entry.step.from, stepNames),
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
