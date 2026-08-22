import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "../config/errors.js";
import { loadConfig } from "../config/load-config.js";
import { cjsTsMismatchExplanation, isCommonJsProject } from "../config/module-kind.js";
import type { NukadokoConfig } from "../config/schema.js";
import { BUILTIN_FIXTURE_NAMES } from "../context.js";
import {
  discoverSteps,
  type Vocabulary,
  type VocabularyEntry,
} from "../discover/discover-steps.js";
import { DuplicateCompatStepError, DuplicateStepError } from "../discover/errors.js";
import { buildFixtureGraph, type FixtureGraph } from "../fixture/graph.js";
import { malformedFromEntryMessage, tryFromCandidates, type Step, type StepFromMap } from "../step/define-step.js";
import { FixtureNotDestructuredError } from "../step/fixture-names.js";
import { inferNeeds } from "../step/infer-needs.js";
import { stepNeeds } from "../step/step-needs.js";

// Responsibility: the one path both `nuka steps` and `nuka describe` share —
// load the project's config, then discover its vocabulary. Kept out of
// run-cli.ts so that path is unit-testable without going through yargs.
// `discoverSteps` also returns compat-origin parameter type registrations —
// irrelevant to `steps`/`describe`, which only ever list/describe the step
// vocabulary itself, so this module drops that half of the result.
// `formatVocabulary` below is `nuka steps`' non-JSON rendering, also kept
// here as a pure function — `run-cli.ts`'s handler passes a `WritableSink`,
// which can't answer "how wide is the terminal", so the width this
// function wraps to is resolved by the caller and passed in as a plain
// number.
//
/** One `discoverSteps`-style import failure, before this module renames its
 * `filePath` field to `file` for `--json` (`toImportFailureSummaries`
 * below) — kept structural rather than importing `DiscoveryResult`'s own
 * field type, since the only thing this module needs from it is the shape. */
export interface RawImportFailure {
  readonly filePath: string;
  readonly message: string;
}

/** Default `false`, same convention as `discoverSteps`' own
 * `tolerateImportFailures` (src/discover/discover-steps.ts) — `run`/`do`/
 * `init` build their own vocabulary without ever passing this at all
 * (those stay fail-fast, only `steps`/`describe` opt in here), so an
 * unspecified option here still means exactly the pre-existing behavior. */
export interface LoadVocabularyOptions {
  readonly tolerateImportFailures?: boolean;
}

/** Also returns `config` — `nuka steps --json`'s own `needs_browser` now
 * needs the fixture dependency graph (`buildFixtureGraph(config)`) to
 * compute its transitive closure through `config.fixtures`, and building
 * that graph needs `config` itself. `describe`'s own handler simply
 * ignores this second field, unchanged.
 *
 * Also returns `importFailures` — always `[]` unless the caller passes
 * `{ tolerateImportFailures: true }`, in which case a broken step file is
 * collected here instead of rejecting this whole call, the same tolerant
 * mode `nuka check`/`nuka tend` already use (src/check/analyze.ts,
 * src/tend/analyze.ts). */
export async function loadVocabulary(
  rootDir: string,
  options: LoadVocabularyOptions = {},
): Promise<{
  readonly vocabulary: Vocabulary;
  readonly config: NukadokoConfig;
  readonly importFailures: readonly RawImportFailure[];
}> {
  const config = await loadConfig(rootDir);
  const { vocabulary, importFailures } = await discoverSteps(rootDir, config.featuresDir, options);
  return { vocabulary, config, importFailures };
}

/** Thrown by {@link assertFeaturesDirExists}. `discoverSteps` itself
 * treats a missing `featuresDir` as "nothing found here"
 * (src/discover/discover-steps.ts's own `walkStepFiles`) rather than an
 * error, on purpose: an empty vocabulary is a valid answer for a project
 * that does have a `featuresDir`, just no steps in it yet. But `nuka
 * steps` was reusing that same leniency for a project that has no
 * `featuresDir` at all, which is a different fact — indistinguishable
 * from the empty-vocabulary case in `--json`'s own `{"steps": [], ...}`
 * output, `nuka check`'s `features-dir-missing` already tells the two
 * apart (src/check/config-check.ts), and this error, and the message it
 * carries, matches that check's own wording so the same mistake reads
 * the same way from either command. */
export class FeaturesDirMissingError extends Error {
  constructor(
    readonly featuresDir: string,
    readonly resolvedPath: string,
  ) {
    super(`featuresDir "${featuresDir}" does not exist at ${resolvedPath}`);
    this.name = "FeaturesDirMissingError";
  }
}

/** Throws {@link FeaturesDirMissingError} when `config.featuresDir` does not
 * exist on disk, the same condition `nuka check`'s `features-dir-missing`
 * checks (src/check/config-check.ts) — kept here, not called from
 * `loadVocabulary` itself, so `nuka describe` (this check's own scope was
 * `nuka steps` alone) keeps its own existing behavior unchanged. */
export function assertFeaturesDirExists(rootDir: string, config: NukadokoConfig): void {
  const featuresRoot = path.join(rootDir, config.featuresDir);
  if (!existsSync(featuresRoot)) {
    throw new FeaturesDirMissingError(config.featuresDir, featuresRoot);
  }
}

/** `{ file, message }` per import failure — `file`, not `discoverSteps`'
 * own `filePath`, to match every other `--json` field this CLI already
 * uses for a location (`CheckIssue.file`), rather than this one command
 * inventing a second name for the same thing. */
export interface ImportFailureSummary {
  readonly file: string;
  readonly message: string;
}

export function toImportFailureSummaries(
  failures: readonly RawImportFailure[],
): ImportFailureSummary[] {
  return failures.map((failure) => ({ file: failure.filePath, message: failure.message }));
}

/** stderr's own tail listing: unreadable files are listed there, at the
 * tail, so stdout's own shape, json or text, never has to carry it.
 * Returns `""` (nothing to write) when
 * `failures` is empty, so a caller can call this unconditionally. Same
 * newline-collapsing as src/cli/check.ts's own `formatIssueLine` — an
 * import error's message can itself carry embedded newlines.
 *
 * Takes `rootDir` so it can append the same CJS/.ts mismatch sentence
 * `nuka check`'s `step-file-import-failed` already does
 * (`cjsTsMismatchExplanation`, src/config/module-kind.ts). A project's
 * first command is not always `check`, and Node's own "Cannot find module"
 * is the same misleading message here as it is there. */
export function formatImportFailuresStderr(
  rootDir: string,
  failures: readonly ImportFailureSummary[],
): string {
  if (failures.length === 0) {
    return "";
  }
  const cjsProject = isCommonJsProject(rootDir);
  const lines = failures.map((failure) => {
    const explanation = cjsTsMismatchExplanation(cjsProject, failure.file);
    return `  ${failure.file}: ${failure.message.replace(/\s*\n\s*/g, " ")}${explanation}`;
  });
  return `${failures.length} step file${failures.length === 1 ? "" : "s"} could not be imported:\n${lines.join("\n")}\n`;
}

// `StepNames`: a step's own `from` field (src/step/define-step.ts's
// `StepFromMap`) names its upstream by the `Step` object itself, never by
// name — the same identity-over-name choice `ctx.resultOf` makes, and for
// the same reason (docs/spec.md "Chaining steps"). Rendering `from` for
// `nuka steps --json`/`nuka describe` still has to show a *name*
// ("projectId" ← "create-project.id"), which only exists at discovery
// time. `summarize`/`describeContract` below take one `VocabularyEntry` at
// a time, never the whole `Vocabulary`, so neither can resolve an upstream
// Step's name from its own argument alone — hence this second, required
// parameter, built once per command by `buildStepNames` below and
// threaded through. A previous version of this module kept that lookup in
// a module-level `WeakMap`, populated as a `loadVocabulary` side effect:
// that made a caller's *order* (load, then summarize) load-bearing in a
// way neither type signature said, and left "(unregistered step)"
// ambiguous between "really never discovered" and "just called before
// that side effect ran". Passing the lookup as an argument makes
// forgetting it a compile error instead.
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
 * shape) or an array of them for a multi-candidate key: the
 * array-vs-object distinction itself is how a reader tells a key with one
 * candidate from a key with several, without a separate count field. */
interface FromCandidateSummary {
  readonly step: string;
  readonly key: string;
}

/** One `from` key this file's own rendering could not read at all — an
 * `as`-cast declaration whose runtime value is neither a `[Step, string]`
 * tuple nor a list of them (`tryFromCandidates` returning `null`). Carries
 * the key by itself, alongside the step's own `name` a reader already has
 * from the enclosing `StepSummary`/`TypedStepContract` (a typed step's own
 * `name` *is* its file's basename, discovery's own naming rule — so "which
 * file" and "which step" are already the same one field, not two this
 * needs to repeat). */
export interface FromKeyError {
  readonly key: string;
  readonly message: string;
}

/** `fromSummary`/`fromHumanReadable` share this shape: the entries they
 * could render, and, separately, the keys they could not — so one step
 * with one broken `from` key still shows every other key it declares
 * (and every other step in the vocabulary), rather than the whole call
 * throwing and taking the rest of `nuka steps`/`nuka describe`'s output
 * down with it. */
interface FromRendering<TRendered> {
  readonly rendered: TRendered | undefined;
  readonly errors: readonly FromKeyError[] | undefined;
}

/** `nuka steps --json`'s own rendering of a step's `from` — one entry per
 * key, `undefined` (hence omitted, `rationale`'s own convention) when the
 * step declares no `from` at all, or when every key it declares turned out
 * to be unreadable (`errors` on the same `FromRendering` is where that
 * shows instead). A key with exactly one candidate keeps the original
 * `{ step, key }` object shape untouched (existing output for existing
 * steps does not change); a key with more than one is an array of that
 * same shape, `[{ step, key }, ...]` — deliberately not always-an-array,
 * so a consumer written against the single-candidate shape keeps working,
 * and a reader can tell "one candidate" from "several" by checking
 * `Array.isArray` (or simply `.length`) without a separate field either
 * way. A key whose own entry is unreadable is left out of `rendered`
 * entirely (nothing to show) and named in `errors` instead — not
 * `{ step, key }` with placeholder values, which a reader could mistake
 * for real data. */
function fromSummary(
  from: StepFromMap,
  stepNames: StepNames,
): FromRendering<Record<string, FromCandidateSummary | readonly FromCandidateSummary[]>> {
  const entries = Object.entries(from);
  if (entries.length === 0) {
    return { rendered: undefined, errors: undefined };
  }
  const result: Record<string, FromCandidateSummary | readonly FromCandidateSummary[]> = {};
  const errors: FromKeyError[] = [];
  for (const [key, entry] of entries) {
    const candidates = tryFromCandidates(entry);
    if (candidates === null) {
      errors.push({ key, message: malformedFromEntryMessage(key, entry) });
      continue;
    }
    const rendered = candidates.map(
      ([upstream, upstreamKey]): FromCandidateSummary => ({
        step: upstreamStepName(upstream, stepNames),
        key: upstreamKey,
      }),
    );
    result[key] = rendered.length === 1 ? rendered[0]! : rendered;
  }
  return {
    rendered: Object.keys(result).length > 0 ? result : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/** `nuka steps --json`'s own rendering of a step's `parts` — the
 * declaring step's own vocabulary name for each part, resolved through
 * `stepNames` the same way `fromSummary` resolves a `from` upstream.
 * `undefined` (hence omitted) when the step declares no `parts` at all —
 * `fromSummary`'s own "absent when empty" convention, reused rather than
 * reinvented. */
function partsSummary(step: Step, stepNames: StepNames): readonly string[] | undefined {
  if (step.parts.length === 0) {
    return undefined;
  }
  return step.parts.map((part) => upstreamStepName(part, stepNames));
}

/** `nuka describe`'s own rendering of a step's `from` — one human-readable
 * "step.key" string per key, the same "arrow" shape docs/spec.md "Chaining
 * steps" itself uses in prose ("`projectId` ← `createProject.id`"),
 * deliberately different from `fromSummary`'s more structured shape above:
 * `nuka describe` is the one command meant for a person to read directly,
 * `nuka steps --json` the one meant for a program to parse. `undefined`
 * (hence omitted) under the same condition as `fromSummary`. A key with
 * more than one candidate reads as "either of A or B" — spelled out so a
 * person skimming `nuka describe` sees the "exactly one of these, never
 * both" relationship the JSON form only implies through array length. */
function fromHumanReadable(from: StepFromMap, stepNames: StepNames): FromRendering<Record<string, string>> {
  const entries = Object.entries(from);
  if (entries.length === 0) {
    return { rendered: undefined, errors: undefined };
  }
  const result: Record<string, string> = {};
  const errors: FromKeyError[] = [];
  for (const [key, entry] of entries) {
    const candidates = tryFromCandidates(entry);
    if (candidates === null) {
      errors.push({ key, message: malformedFromEntryMessage(key, entry) });
      continue;
    }
    const rendered = candidates.map(
      ([upstream, upstreamKey]) => `${upstreamStepName(upstream, stepNames)}.${upstreamKey}`,
    );
    result[key] = rendered.length === 1 ? rendered[0]! : `either of ${rendered.join(" or ")}`;
  }
  return {
    rendered: Object.keys(result).length > 0 ? result : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/** `nuka describe`'s own rendering of a step's `parts` — one
 * `{ name, description }` pair per part, `from`'s own "step.key" arrow
 * shape has no equivalent here (a part is named and described, not tied
 * to one args key), so this stays a plain list. Deliberately no reverse
 * index (which steps call this one as a part): that answer needs the
 * whole vocabulary scanned, and `nuka describe` looks at one step's own
 * contract only (docs/spec.md "Parts": "An unused part is not decidable
 * at all" — the reverse listing has the same shape of problem, scoped to
 * a single `nuka describe` call rather than `nuka tend`). `undefined`
 * (hence omitted) under the same condition as `partsSummary` above. */
function partsHumanReadable(
  step: Step,
  stepNames: StepNames,
): ReadonlyArray<{ readonly name: string; readonly description: string }> | undefined {
  if (step.parts.length === 0) {
    return undefined;
  }
  return step.parts.map((part) => ({ name: upstreamStepName(part, stepNames), description: part.description }));
}

/**
 * `nuka steps`' one row per vocabulary entry. `kind` is always present:
 * it is the field that tells a typed entry from a compat one, so it can't
 * be conditional the way `description`/`mutates` are — those are
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
   * (`src/step/step-needs.ts`'s `stepNeeds`) — present and possibly `[]`
   * for a typed entry (a step that needs no fixtures still gets the key, so
   * "no needs" reads differently from "not a typed entry", which omits it,
   * the same convention `mutates` already follows), absent entirely for a
   * compat entry (no `run()` exists to read). Not repeated in
   * `formatVocabulary`'s text rendering below: the full list is a
   * `--json` concern, the text output only marks `needsBrowser`.
   *
   * `null`, never `undefined`, when `stepNeeds` itself throws (a `run()`
   * whose first argument can't be read as fixture names at all) — that
   * step's name/pattern/description still came through cleanly, so it
   * stays in the output instead of taking the whole `nuka steps` call
   * down with it (this same throw used to propagate straight out of
   * `summarize` and kill every other step's own entry too); `needs_error`
   * on the same entry carries why. `null` reads as "couldn't tell",
   * distinct from `[]`'s "asked, and there is nothing" the same way
   * `needs`'s own presence already distinguishes typed from compat. */
  readonly needs?: readonly string[] | null;
  /** Whether this step's own fixture needs open a browser (`page` or
   * `context` among `needs`, `stepNeeds`'s own doc comment explains why
   * that check will need to widen once a user-defined fixture exists) —
   * lets an agent see, before running anything, which scenarios never open
   * one at all. Same presence rule as `needs`: present for every typed
   * entry, absent for a compat one. JSON key is `needs_browser`, not
   * `needsBrowser` (this project's own snake_case convention for a
   * `--json` field, matching `record.json`'s `waited_ms`/`http_reads`).
   * Also omitted, alongside `needs: null`, when `stepNeeds` throws — a
   * browser-need verdict this file can't derive is not one it states. */
  readonly needs_browser?: boolean;
  /** `stepNeeds`'s own thrown error message, present only alongside
   * `needs: null` — see that field's own doc comment. */
  readonly needs_error?: string;
  /** A best-effort guess at this step's fixture needs, read by scanning
   * `run()`'s own source text for its first argument's member accesses —
   * present only alongside `needs: null` and only when that guess could be
   * attempted at all (`src/step/infer-needs.ts`'s own `inferNeeds`, called
   * only for the one throw shape it can key a scan on: `run(ctx, args)`'s
   * own un-destructured first argument). Deliberately a field of its own,
   * never merged into `needs`: `needs` is read from a destructuring
   * pattern and used to decide what to build before a step runs; this is
   * a lexical guess about a step that cannot run yet, kept for the sake of
   * an agent tallying what a migration still owes, not for anything that
   * decides what nukadoko does. `needs_browser` is never inferred
   * alongside this for the same reason — see that field's own doc
   * comment. Possibly `[]` (attempted, and nothing recognizable was
   * touched), same "asked, and there is nothing" reading `needs: []`
   * already carries for a typed entry. */
  readonly needs_inferred?: readonly string[];
  /** Where each declared args key not left to a pattern capture comes
   * from — key → `{ step, key }`, the upstream step's own name and the
   * `returns` key read from it, or an array of that same shape when the
   * key lists more than one mutually exclusive candidate producer. Absent
   * for a compat entry (no declaration exists) and omitted entirely, like
   * `mutates`, rather than serialized as `{}`, when a typed step declares
   * no `from` at all. Deliberately absent from `formatVocabulary`'s text
   * rendering below — `nuka steps` (non-JSON) stays one line per step. */
  readonly from?: Record<string, { step: string; key: string } | ReadonlyArray<{ step: string; key: string }>>;
  /** Every `from` key this step declares whose own entry could not be read
   * at all (docs/spec.md "Chaining steps" never sanctions the `as`-cast
   * escape hatch that produces one, but nothing stops a step author from
   * writing it anyway) — a bare string or a `Step` passed directly instead
   * of wrapped in a `[step, "key"]` tuple, most often. Present only when at
   * least one such key exists; that key is simply missing from `from`
   * above rather than appearing there with placeholder values. A step with
   * `from_errors` is otherwise still fully listed, alongside every other
   * step in the vocabulary — the fact this field exists at all is what
   * keeps one broken key from taking `nuka steps`/`nuka describe` down for
   * every step, typed or compat, that has nothing wrong with it. */
  readonly from_errors?: readonly FromKeyError[];
  /** Vocabulary names of the steps this step declares in its own `parts`
   * (docs/spec.md "Parts"), in declaration order — resolved through the
   * same `stepNames` lookup `from` uses, so an unregistered part reads
   * `"(unregistered step)"` the same way an unregistered `from` upstream
   * does. Absent for a compat entry (no declaration exists) and omitted
   * entirely, like `from`, when a typed step declares no `parts` at all.
   * `needs`/`needs_browser` already fold a part's own needs into this
   * step's, so this field only names *which* steps are called, not what
   * they need. */
  readonly parts?: readonly string[];
}

/** The fixture names `needs_inferred` is allowed
 * to keep, mirroring `stepNeeds`'s own graph-or-builtins fallback
 * just below: `graph.nodes` is already builtins ∪ `config.fixtures` (src/
 * fixture/graph.ts's own `FixtureGraph` doc comment), so a caller that
 * built one hands back exactly that; a caller with no config-derived graph
 * at all falls back to builtins alone, same as `opensBrowser` does in src/
 * step/step-needs.ts for the same reason. */
function knownFixtureNamesFor(graph: FixtureGraph | undefined): ReadonlySet<string> {
  return graph !== undefined ? new Set(graph.nodes.keys()) : new Set(BUILTIN_FIXTURE_NAMES);
}

/** One typed step's own `needs`/`needs_browser`/`needs_error`/
 * `needs_inferred` fields, computed once and shared verbatim by `summarize`
 * (`nuka steps --json`) and `describeContract` (`nuka describe`) — an agent
 * calling `describe` for one step's "full contract" (this command's own
 * yargs description) needs the same fixture-need verdict `steps --json`
 * already computes for that step, not a second copy of this logic that
 * could silently drift from it. `graph` is optional so every call site
 * that has no config-derived fixture graph handy keeps working unchanged
 * (`needs_browser` falls back to `stepNeeds`'s own direct membership
 * check) — `nuka steps --json`/`nuka describe`'s own handlers (run-cli.ts)
 * are the two callers that build and pass one.
 *
 * `stepNeeds` throws for a `run()` it can't read fixture names from at all
 * (src/step/step-needs.ts, via src/step/fixture-names.ts) — that used to
 * propagate straight out of `summarize` and take every other step's own
 * entry down with it: one unparseable `run()` should not empty the whole
 * vocabulary a reader is trying to see. Caught here instead, so a caller
 * iterating the whole vocabulary can keep going past it.
 */
function needsFields(
  step: Step,
  graph: FixtureGraph | undefined,
): {
  readonly needs: readonly string[] | null;
  readonly needs_browser?: boolean;
  readonly needs_error?: string;
  readonly needs_inferred?: readonly string[];
} {
  try {
    const { needs, needsBrowser } = stepNeeds(step, graph);
    return { needs, needs_browser: needsBrowser };
  } catch (error) {
    // A guess at what `error` couldn't state as a contract — attempted
    // only for the one throw shape `inferNeeds` can key a scan on
    // (`FixtureNotDestructuredError`'s own bare first-argument identifier,
    // e.g. `run(ctx, args)`'s `"ctx"`); a default-value or rest-property
    // throw leaves no such identifier to scan by, so this stays
    // `undefined` for those and `needs_inferred` is simply omitted: no
    // guess reads as no guess, never as an empty one.
    const inferred =
      error instanceof FixtureNotDestructuredError
        ? inferNeeds(step.run, error.firstArgumentText, knownFixtureNamesFor(graph))
        : undefined;
    return {
      needs: null,
      needs_error: error instanceof Error ? error.message : String(error),
      ...(inferred !== undefined ? { needs_inferred: inferred } : {}),
    };
  }
}

/** `graph` is optional so every call site
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
  const fromResult = fromSummary(entry.step.from, stepNames);
  return {
    name: entry.name,
    kind: "typed" as const,
    patterns: entry.step.patterns,
    description: entry.step.description,
    mutates: entry.step.mutates,
    from: fromResult.rendered,
    from_errors: fromResult.errors,
    parts: partsSummary(entry.step, stepNames),
    ...needsFields(entry.step, graph),
  };
}

/**
 * `nuka steps`' non-JSON rendering: one block per entry, blank-line
 * separated, no trailing blank line. A
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
  // `needs` itself (the full destructured-name list) stays out of this
  // text rendering on purpose: the full enumeration is a `--json`
  // concern, `--json` is where a reader gets the list; `needs_browser`
  // gets a single word, appended only when true, the same "mark the fact,
  // say nothing when there's nothing to say" choice `compat` above
  // already makes for a step with no declaration at all.
  const browserLabel = s.needs_browser ? "  browser" : "";
  // A heading marker plus its own reason line — never both this and
  // `browserLabel`, since `needs_browser` is itself only ever set when
  // `needs_error` is not. `needs_inferred` swaps the marker word itself
  // rather than adding a second one — a reader still sees exactly one
  // word at this position, now saying "guessed, don't trust it" instead
  // of "gave up" when a guess was possible. The reason line just below
  // stays exactly as it was either way (still `needs_error`, never the
  // guessed list itself — that stays a `--json`-only concern, same as
  // `needs` in the successful case).
  const needsErrorLabel =
    s.needs_error === undefined ? "" : s.needs_inferred !== undefined ? "  needs (inferred)" : "  needs unreadable";
  // A step whose `from` has at least one unreadable key gets the same kind
  // of marker `needsErrorLabel` already does — the fact is worth a person's
  // attention even in the one-line-per-step text listing, though the full
  // list of broken keys, like `needs` itself, stays a `--json`-only detail.
  const fromErrorLabel = s.from_errors !== undefined ? "  from unreadable" : "";
  const lines = [`${s.name}  ${s.kind}  ${mutatesLabel}${browserLabel}${needsErrorLabel}${fromErrorLabel}`];
  const patterns = s.patterns.length > 0 ? s.patterns : ["(no pattern)"];
  for (const pattern of patterns) {
    lines.push(...wrapIndented(pattern, width));
  }
  if (s.description !== undefined) {
    lines.push(...wrapIndented(s.description, width));
  }
  if (s.needs_error !== undefined) {
    lines.push(...wrapIndented(`needs: ${s.needs_error}`, width));
  }
  if (s.from_errors !== undefined) {
    for (const fromError of s.from_errors) {
      lines.push(...wrapIndented(`from: ${fromError.message}`, width));
    }
  }
  return lines.join("\n");
}

/**
 * Wraps `text` at space boundaries only — a pattern is a cucumber-expression
 * or regex and a description is free-form prose, and splitting either mid-
 * word would make it uncopyable as the literal thing it names. A single word
 * wider than `width` is left on its own line unsplit for the same reason:
 * the terminal's own wrapping is the fallback, not this function's job to
 * improve on.
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
   * one (omitted, not an empty string, same convention as `used` on a
   * step record). Deliberately absent from `StepSummary`/`summarize` below —
   * `nuka steps` stays one line per step. */
  readonly rationale?: string;
  /** Human-readable rendering of `from` —
   * `fromHumanReadable`'s own doc comment explains the "step.key" shape and
   * why it differs from `StepSummary.from`'s more structured one. Omitted,
   * not `{}`, when the step declares no `from` at all — same convention as
   * `rationale` just above. */
  readonly from?: Record<string, string>;
  /** Every `from` key this step declares whose own entry could not be read
   * at all — same condition and same shape as `StepSummary.from_errors`
   * (see that field's own doc comment), rendered here instead of there
   * since `nuka describe` reads one step at a time. */
  readonly from_errors?: readonly FromKeyError[];
  /** This step's own declared `parts` (docs/spec.md "Parts"), one entry
   * per part naming it and repeating its own `description` — the same
   * "no reverse index" scope `partsHumanReadable`'s own doc comment
   * explains. Omitted, not `[]`, when the step declares no parts at all —
   * same convention as `rationale`/`from` just above. */
  readonly parts?: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  /** The fixture names this step's own `run()` destructures — same field,
   * same computation (`needsFields`, shared with `summarize` below), and
   * same presence rule as `StepSummary.needs`: this command's own yargs
   * description calls its output "full contract", so a reader must not
   * have to also call `nuka steps --json` to learn what this step needs
   * before running it. */
  readonly needs: readonly string[] | null;
  /** Same field, same computation, and same presence rule as
   * `StepSummary.needs_browser`. */
  readonly needs_browser?: boolean;
  /** Same field, same computation, and same presence rule as
   * `StepSummary.needs_error`. */
  readonly needs_error?: string;
  /** Same field, same computation, and same presence rule as
   * `StepSummary.needs_inferred`. */
  readonly needs_inferred?: readonly string[];
  readonly args: JsonSchema;
  readonly returns: JsonSchema;
}

/**
 * `nuka describe` on a compat entry: no schema
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

/** `graph` is optional for the same reason `summarize`'s own parameter is
 * (that function's own doc comment) — `nuka describe`'s own handler
 * (run-cli.ts) is the caller that builds and passes one, the same
 * `buildFixtureGraph(config)` call `nuka steps --json`'s handler already
 * makes. */
export function describeContract(entry: VocabularyEntry, stepNames: StepNames, graph?: FixtureGraph): StepContract {
  if (entry.kind === "compat") {
    return {
      kind: "compat",
      name: entry.name,
      pattern: entry.compat.patternSource,
      message:
        'compat steps have no type contract; promote this pattern to defineStep to add one (docs/spec.md "What compat steps lack")',
    };
  }
  const fromResult = fromHumanReadable(entry.step.from, stepNames);
  return {
    kind: "typed",
    name: entry.name,
    patterns: entry.step.patterns,
    description: entry.step.description,
    mutates: entry.step.mutates,
    // `rationale` is `string | undefined` on `Step`; `JSON.stringify` drops
    // an `undefined`-valued key on its own, so a step with none simply has
    // no "rationale" key in the output.
    rationale: entry.step.rationale,
    from: fromResult.rendered,
    from_errors: fromResult.errors,
    parts: partsHumanReadable(entry.step, stepNames),
    ...needsFields(entry.step, graph),
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
