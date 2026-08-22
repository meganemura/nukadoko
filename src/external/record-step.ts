import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext, Page } from "playwright";
import type { z } from "zod";
import { formatValidationIssues } from "../binding/format-issues.js";
import { resolveUse, type ResolveUseSuccess } from "../cli/resolve-use.js";
import { loadConfig } from "../config/load-config.js";
import { BUILTIN_FIXTURE_NAMES } from "../context.js";
import { buildStepFixtures, createStepContext, type DisposeResult } from "../context/create-context.js";
import { loadEnvFiles } from "../context/env.js";
import { mergeTruncated } from "../context/evidence.js";
import { omitUsedResults } from "../context/used.js";
import { DEFAULT_ENVIRONMENT_NAME } from "../environment/resolve-environment.js";
import { readStepRecordById } from "../record/read-step-record.js";
import { generateStepRecordId } from "../record/record-id.js";
import type { ErrorKind, StepRecord } from "../record/types.js";
import { writeStepRecord } from "../record/write-step-record.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { redact } from "../secrets/redact.js";
import { malformedFromEntryMessage, tryFromCandidates, type Step } from "../step/define-step.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";
import { strictArgsSchema } from "../step/strict-args.js";

// Responsibility: run one typed step from inside a Playwright Test spec and
// write the same step record shape `nuka do` writes (docs/spec.md "The
// second door"), so a spec run this way accumulates records `nuka harvest`
// can turn into a feature draft, closing the gap that door's own doc
// comment names: "What does not cross is the record... there is no
// executor in that home." This module is that home's executor, on the one
// slice it drives (a typed step's own `args`/`returns` schemas, `request`,
// an injected `page`), not a general Playwright fixture wrapper.
//
// `stepFixtureNames(step)` (its transitive closure over `parts`) is checked
// against `SUPPORTED_FIXTURE_NAMES`, below, before any record exists —
// plus `page`/`context`, checked separately from that set because they are
// supported exactly when `options.page` was given for *this* call (this
// file's own `ExperimentalRecordStepOptions.page` doc comment: no second,
// competing browser ever launches here, so a step naming either without a
// `page` supplied has nothing this module can build for it).
// Refusing before `recordId`/`evidenceDir` exist matches `nuka do`'s own
// setup-phase refusals (src/cli/do.ts): a step whose fixtures cannot be
// built here never began, so no record is cited for it. A custom
// `config.fixtures` name fails the same check for a related but different
// reason: nothing here resolves `config.fixtures` at all yet (only the
// closed subset of `StepFixtures` this module can build is), so a name
// outside that subset is refused the same way regardless of why it isn't
// supported.
//
// Config (`nukadoko.config.ts`), env, and secrets load the same way `nuka
// do` loads them (src/cli/do.ts), so http.jsonl's redaction and
// `ctx.env`/`ctx.requireEnv` behave identically whether a step ran through
// `nuka do` or through this module. Left out on purpose, all named in the
// task this module was built for: `--env`/`--session` (no environment or
// session concept exists here yet — always `DEFAULT_ENVIRONMENT_NAME`/
// `null`), the version probe, and read-only policy enforcement. Each is a
// real gap, not an oversight, and each is additive: none of them changes
// this module's own record shape or its `kind: "external"` meaning if
// added later.
//
// The returned `result` is `runResult`'s own validated value, never the
// redacted one written to record.json: a caller chaining this function's
// own return value into further Playwright calls (`cart.id`, an auth
// token, ...) needs the real value to keep driving its own test, the same
// way calling the shared plain function directly always did. Redaction
// only ever reaches the two files this module writes (record.json,
// http.jsonl via `wrapRequestContextWithLogging`), never the in-memory
// value handed back to the caller — the same three-exits rule docs/spec.md
// "Secrets" states for `nuka do`, minus the stdout copy this module has
// none of.
//
// A failed execution (bad args, the step's own throw, a bad result) still
// writes a step record (`status: "failed"`), then throws — args/returns
// validation failures throw a fresh `Error` naming what failed, the step's
// own throw is rethrown unchanged, the same "the caller's own stack, not a
// wrapper" rule `ctx.call` already follows (src/context/create-context.ts).
// A Playwright Test spec calling this function needs nothing special to
// fail its own test the normal way: the failure propagates exactly as if
// the wrapped plain function itself had thrown.
//
// `options.use` (added after this module first shipped without it) is
// `nuka do --use`'s own meaning, reached through the same mechanism
// (src/cli/resolve-use.ts's `resolveUse`): a spec that reads a previous
// call's own `result` and passes it into the next call's `args` — the
// natural way to write chained calls by hand — never left anything in
// `used` for that chain, so `nuka harvest` (which only ever sees the step
// records, never the spec source) had no way to tell the value apart from
// one typed in by a human, and baked that one call's own id-of-the-moment
// into the draft as a literal. A draft built that way stayed green only by
// accident, against whichever backend happened to still hold that literal
// in memory; swapping the backend broke it, silently, for a reason no line
// in the feature file named. `use` closes that gap by recording the same
// provenance `--use` already does, so a chained call now leaves `nuka
// harvest` the evidence it needs to render the key as a chain instead of a
// value.
//
// `resolveUse`'s own `stepNameOf: ReadonlyMap<Step, string>` needs a name
// for every upstream `Step` object a `from` entry might reference, and this
// module cannot get that from this project's own discovery — this file's
// own header, above, already explains why: a `Step` object discovery
// produces (via `scoped.import`) never equals the one a caller's own
// `import` produced, so a discovered vocabulary's map would never match a
// `from` entry's own `Step` reference. `externalStepNames` (a
// process-lifetime `WeakMap<Step, string>`, below) is the name source
// instead: every call registers its own `step`/`name` pair there,
// regardless of whether it uses `use` itself, so a later call's `from`
// entries resolve against whatever this same process already recorded.
// That is also this feature's one real limit, worth stating plainly rather
// than leaving a caller to discover it by a refusal: `use` here only
// resolves against an upstream step this same process already ran through
// `experimental_recordStep` — an id minted by `nuka do`, or by a
// *different* process's own `experimental_recordStep` calls, reads back
// fine from disk but was never registered here, so `resolveUse` refuses it
// the same way it refuses an id naming an unrelated step (loud, not
// silent, matching this project's own "nothing breaks silently" rule).
//
// EXPERIMENTAL, marked by name (`experimental_` first, matching
// `experimental_callWebmcpTool`'s own convention — src/webmcp/call-tool.ts)
// rather than by a runtime flag, for the reason that module's own header
// gives: the whole point is that a caller cannot reach this surface
// without typing the word. Remove the prefix only once this holds:
//   - the API shape above (four exported names, one call site) has run
//     unchanged against a real Playwright Test suite migrated this way,
//     not only against this package's own tests
// The other original condition is now met, not merely restated: an
// injected `page` (`options.page`, not only `request`) is supported, so a
// step whose fixtures include `page`/`context` is no longer refused
// outright by this module. A third condition held once and no longer needs
// restating as a
// precondition, only as a fact: before `use` existed, a spec that chained
// calls by passing a previous `result` into the next `args` was not
// actually practical to harvest (the paragraph above, on `use`, is the
// record of that).

/** Every `StepFixtures` name this module can always build, regardless of
 * whether a call passes `options.page`
 * (`BUILTIN_FIXTURE_NAMES`, src/context.ts, minus `page`/`context`) — `page`/
 * `context` are supported too, but only on a call that actually supplies
 * `options.page` (this file's own header), so they are checked separately,
 * in `experimental_recordStep` itself, rather than folded into this set. */
const SUPPORTED_FIXTURE_NAMES = new Set(
  BUILTIN_FIXTURE_NAMES.filter((name) => name !== "page" && name !== "context"),
);

/** `Step` -> the `name` its own `experimental_recordStep` call was given,
 * accumulated across every call this process makes — this file's own header
 * (the `options.use` paragraph) explains why this, not this project's own
 * discovery, is `use`'s name source. Module-scoped on purpose: a `WeakMap`
 * lets a `Step` object be the key without keeping it alive forever, and one
 * shared instance is what lets a later call's `from` entries resolve
 * against an earlier call's own `step` in the same process. */
const externalStepNames = new WeakMap<Step, string>();

/** Thrown when `step`'s own fixture needs (its `run`'s destructured names,
 * closed transitively over `parts`) include a name this module cannot build
 * for this call — `"page"`/`"context"` on a call that passed no
 * `options.page` (this file's own header), or a `config.fixtures` entry (not
 * resolved here, regardless of `options.page`). Thrown before `recordId`/
 * `evidenceDir` exist, so no step record is written for it: the execution
 * never began. */
export class UnsupportedExternalFixtureError extends Error {
  readonly fixtureName: string;

  constructor(fixtureName: string) {
    // Reached for `"page"`/`"context"` only when `options.page` was *not*
    // given — the caller (`experimental_recordStep`, below) already lets
    // both through without throwing whenever it was, so seeing either name
    // here means specifically "no page was supplied", not "page is
    // unsupported in general".
    const isPageFixture = fixtureName === "page" || fixtureName === "context";
    super(
      isPageFixture
        ? `experimental_recordStep cannot build fixture "${fixtureName}": this call passed no options.page ` +
          `(an already-open Playwright page); "page"/"context" are only available on a call that supplies one.`
        : `experimental_recordStep cannot build fixture "${fixtureName}": only ` +
          `${[...SUPPORTED_FIXTURE_NAMES].sort().join(", ")} (plus "page"/"context" when options.page is given) ` +
          `are available; any other name is a config.fixtures entry, which this experimental function does not resolve.`,
    );
    this.name = "UnsupportedExternalFixtureError";
    this.fixtureName = fixtureName;
  }
}

export interface ExperimentalRecordStepOptions {
  /** The vocabulary name nukadoko's own discovery would assign this exact
   * `step` object: its step file's own basename, minus extension
   * (src/discover/discover-steps.ts). Required, not derived, because
   * discovery never runs here — the Playwright spec that imports `step`
   * loads it through its own module resolution, a different realm than
   * tsx's `scoped.import` (create-context.ts's own header describes this
   * same trap for `resultOf`), so no identity-based lookup back to a
   * vocabulary entry is possible. `nuka harvest` joins a step record back
   * to its vocabulary entry by this exact string, so a name that does not
   * match what discovery would assign writes a record harvest cannot
   * place. */
  name: string;
  /** Project root: same directory `nukadoko.config.ts` and `.nukadoko/`
   * live under for `nuka do`/`nuka run`. */
  rootDir: string;
  /** An already-open Playwright `APIRequestContext` — a Playwright Test's
   * own `request` fixture, typically. Read from, logged to http.jsonl, and
   * redacted the same way `ctx.request()` already is (this file's own
   * header); never disposed here — closing it stays whichever caller
   * opened it's own job (docs/spec.md "The second door"). */
  request: APIRequestContext;
  /** An already-open Playwright `Page` — a Playwright Test's own `page`
   * fixture, typically. Optional: omit it for a step that never names
   * `page`/`context`, the same way this module has always worked. When
   * given, `step.run`'s own `page` (and `context`, derived from
   * `page.context()`) is this exact page, `observed`/`page_events` tally
   * its traffic, and neither the page nor its context is ever closed here
   * — same ownership rule as `request`, above (this file's own header). No
   * trace chunk opens and no screenshot is taken for it: the calling
   * Playwright Test spec already owns both for this exact page, so a
   * second copy here would only duplicate evidence that spec's own run
   * already has. */
  page?: Page;
  /** `nuka do --use <record-id>`'s own meaning (docs/spec.md "Single steps
   * (the agent path)"), repeatable the same way: each id fills whichever of
   * `step`'s own `from` keys that step record's step is named by, and lands
   * in this execution's own `used` for `nuka harvest` to read back as a
   * chain (this file's own header, the `options.use` paragraph). A key
   * `args` (the second parameter, above) already set wins over a `use`
   * value for that same key — the same priority `nuka do` gives `--args`.
   * Omit it, or pass `[]`, for a call that fills every `from`-eligible key
   * through `args` directly; unrelated to whether `step` declares `from` at
   * all. Every id here must name a step this same process already recorded
   * through `experimental_recordStep` — see this file's own header for why
   * an id from anywhere else is refused. */
  use?: readonly string[];
}

export interface ExperimentalStepExecution<TReturns extends z.ZodTypeAny> {
  /** `step`'s own validated return value — the same value calling the
   * shared plain function directly would have produced, never the redacted
   * copy this module writes to record.json (this file's own header). */
  readonly result: z.infer<TReturns>;
  /** The step record id this execution wrote under
   * `<stateDir>/records/steps/<id>/record.json` — the id `nuka harvest`
   * takes on its own command line to build a feature draft from a sequence
   * of these. */
  readonly stepRecordId: string;
}

/**
 * Runs `step` with `args`, the same way `nuka do` runs a typed step, and
 * writes a `kind: "external"` step record (this file's own header) to
 * `options.rootDir`'s state directory. Reuses `options.request` (and
 * `options.page`, when given) rather than launching either of its own —
 * see `CreateStepContextOptions.request`/`.page` (src/context/
 * create-context.ts) for why closing either is never this module's job.
 *
 * @throws {UnsupportedExternalFixtureError} `step`'s own fixture needs (or
 * any of its `parts`') name `page`/`context` on a call that passed no
 * `options.page`, or name a `config.fixtures` entry — before any step
 * record is written.
 * @throws {Error} an `options.use` id is unknown, names a non-`"ok"` step
 * record, names a step that is not registered here (this file's own
 * header) or is not among `step.from`'s upstreams, is missing the result
 * key `from` names, or two `use` ids disagree about which producer fills
 * the same key — before any step record is written, the same family as
 * {@link UnsupportedExternalFixtureError}.
 * @throws {Error} `args` failed `step.args`, or `step`'s own return value
 * failed `step.returns` — after a `status: "failed"` step record is
 * written.
 * Also rethrows whatever `step.run` itself threw, unchanged, after writing
 * the same kind of failed record.
 *
 * `args` must satisfy `step.args` exactly on this overload, the same shape
 * a direct call to the plain function requires: `options` sets no `use`
 * here, so no args key is ever filled from anywhere else, and a missing
 * required key is a compile error instead of waiting for the run-time
 * `args validation failed` throw.
 */
export function experimental_recordStep<TArgs extends z.ZodTypeAny, TReturns extends z.ZodTypeAny>(
  step: Step<TArgs, TReturns>,
  args: z.input<TArgs>,
  options: ExperimentalRecordStepOptions & { use?: undefined },
): Promise<ExperimentalStepExecution<TReturns>>;
/**
 * `args` is `Partial<z.input<TArgs>>` on this overload, not the exact shape
 * the overload above requires: a `Step<TArgs, TReturns>` never carries its
 * own `TFrom` (`defineStep`'s return type erases it), so nothing here can
 * tell, at compile time, which of `TArgs`'s keys `options.use` might fill
 * instead. A caller whose `use` does not end up filling some key still gets
 * a real, thrown `args validation failed` error, just at run time instead
 * of at the type checker. See the overload above for `@throws`.
 */
export function experimental_recordStep<TArgs extends z.ZodTypeAny, TReturns extends z.ZodTypeAny>(
  step: Step<TArgs, TReturns>,
  args: Partial<z.input<TArgs>>,
  options: ExperimentalRecordStepOptions & { use: readonly string[] },
): Promise<ExperimentalStepExecution<TReturns>>;
export async function experimental_recordStep<TArgs extends z.ZodTypeAny, TReturns extends z.ZodTypeAny>(
  step: Step<TArgs, TReturns>,
  args: Partial<z.input<TArgs>>,
  options: ExperimentalRecordStepOptions,
): Promise<ExperimentalStepExecution<TReturns>> {
  const { name, rootDir, request, page, use = [] } = options;

  // Registered before anything else, unconditionally — this call's own
  // `step`/`name` pair is what lets a *later* call's `use` resolve a `from`
  // entry naming `step` as an upstream, regardless of whether this call
  // itself used `use`, and regardless of whether it goes on to succeed
  // (this file's own header, the `externalStepNames` doc comment).
  externalStepNames.set(step, name);

  const fixtureNames = stepFixtureNames(step);
  for (const fixtureName of fixtureNames) {
    // `page`/`context` are supported exactly when this call supplied
    // `options.page` (this file's own header) — checked here, alongside
    // `SUPPORTED_FIXTURE_NAMES`, rather than folded into that set, since
    // whether they are available depends on this one call, not on the
    // module as a whole.
    const isPageFixture = fixtureName === "page" || fixtureName === "context";
    if (!SUPPORTED_FIXTURE_NAMES.has(fixtureName) && !(isPageFixture && page)) {
      throw new UnsupportedExternalFixtureError(fixtureName);
    }
  }

  const config = await loadConfig(rootDir);

  // `use` resolved fully here, in setup, before `recordId`/`evidenceDir`
  // exist — mirrors `nuka do`'s own setup-phase `--use` handling
  // (src/cli/do.ts) exactly: every id is checked, and the two-different-
  // producers-for-one-key conflict is caught, before anything is written.
  // `useStepNameOf` only ever holds entries for `step.from`'s own candidate
  // `Step` objects (plus `step` itself) — this file's own header explains
  // why `externalStepNames` is where those names come from. Named apart
  // from `createStepContext`'s own `stepNameOf` option, below, which
  // answers a different question (`ctx.call`'s naming) from a narrower map
  // (`step` only).
  const useStepNameOf = new Map<Step, string>([[step, name]]);
  for (const [key, fromEntry] of Object.entries(step.from)) {
    const candidates = tryFromCandidates(fromEntry);
    if (candidates === null) {
      throw new Error(malformedFromEntryMessage(key, fromEntry));
    }
    for (const [upstream] of candidates) {
      const upstreamName = externalStepNames.get(upstream);
      if (upstreamName !== undefined) {
        useStepNameOf.set(upstream, upstreamName);
      }
    }
  }

  const resolvedUses: ResolveUseSuccess[] = [];
  for (const useRecordId of use) {
    const resolved = resolveUse(useRecordId, step, useStepNameOf, (id) =>
      readStepRecordById(rootDir, config.stateDir, id),
    );
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }
    resolvedUses.push(resolved);
  }

  // Two different `use` ids filling the same key from two different
  // candidate producers — the same ambiguity `nuka do --use` refuses
  // (src/cli/do.ts), replicated here rather than left for `step.args`'
  // own schema to catch (a schema has no way to tell "two candidates
  // disagree" from "one candidate supplied a value we don't like").
  const useProducerByKey = new Map<string, string>();
  for (const resolved of resolvedUses) {
    for (const key of Object.keys(resolved.filled)) {
      const existingProducer = useProducerByKey.get(key);
      if (existingProducer !== undefined && existingProducer !== resolved.used.step) {
        throw new Error(
          `use: key "${key}" is filled by both step "${existingProducer}" and step ` +
            `"${resolved.used.step}". These are different candidate producers for the same ` +
            `\`from\` key, and experimental_recordStep cannot tell which one should win`,
        );
      }
      useProducerByKey.set(key, resolved.used.step);
    }
  }

  const recordId = generateStepRecordId();
  const relativeDir = path.join(config.stateDir, "records", "steps", recordId);
  const evidenceDir = path.join(rootDir, relativeDir);
  await mkdir(evidenceDir, { recursive: true });

  const envFiles = config.envFiles ?? [];
  const envVars = loadEnvFiles(rootDir, envFiles);
  const classification = await classifyEnvFiles(rootDir, envFiles);
  const secrets = buildSecretSet(rootDir, {
    secretSourceFiles: classification.secretSource,
    trackedFiles: classification.tracked,
    publicKeys: config.secrets.public,
    redactKeys: config.secrets.redact,
  });

  const contextHandle = createStepContext({
    config,
    evidenceDir,
    env: envVars,
    secrets,
    request,
    page,
    // Names this step's own `CallEntry`/error messages the same way
    // cli/do.ts's own `stepNameOf` does — the only step this module ever
    // knows the discovered name of is `step` itself (`options.name`,
    // above); anything else `ctx.call` might reach for falls back to
    // create-context.ts's own "never registered" wording, same as `nuka
    // do` running a step this project's discovery never found.
    stepNameOf: (candidate) => (candidate === step ? name : undefined),
    stepTitle: name,
  });

  const startedAt = new Date();

  // `use`'s actual effect — applied here, not in setup, so `recordUsed`
  // rides `contextHandle`'s own collector (it didn't exist yet in setup);
  // mirrors `nuka do`'s own application loop (src/cli/do.ts) exactly,
  // including its priority (`args`, the parameter above, still wins for a
  // key it already set) and its "only a `use` id that actually filled a key
  // lands in `used`" rule. Builds a fresh object rather than mutating
  // `args` in place — unlike `nuka do`'s own `parsedArgs` (freshly parsed
  // from `--args` JSON, owned outright by that one call), `args` here is
  // the caller's own live object, and mutating it would leak this
  // function's own bookkeeping back into the calling spec.
  let effectiveArgs: unknown = args;
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const argsObject: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    for (const resolved of resolvedUses) {
      let filledAnyKey = false;
      for (const [key, value] of Object.entries(resolved.filled)) {
        if (!(key in argsObject)) {
          argsObject[key] = value;
          filledAnyKey = true;
        }
      }
      if (filledAnyKey) {
        contextHandle.recordUsed(resolved.used.step_record_id, resolved.used.step, resolved.used.result);
      }
    }
    effectiveArgs = argsObject;
  }

  let status: "ok" | "failed";
  let result: unknown;
  let errorMessage = "";
  let errorKind: ErrorKind | undefined;
  // The exact value this function throws once the step record below is
  // written — a fresh `Error` for a schema failure, or `step.run`'s own
  // thrown value, unchanged, for a step_error (this file's own header).
  let thrown: unknown;
  // Defaults to the merged-but-unvalidated value (`use` already applied
  // above, in `effectiveArgs`); overwritten with the schema-validated value
  // below on success, so this step record's own `args` never shows a key
  // validation actually rejected or a default validation actually filled in
  // silently — the same reasoning cli/do.ts's own `recordedArgs` follows.
  let recordedArgs: unknown = effectiveArgs;

  const argsResult = strictArgsSchema(step.args).safeParse(effectiveArgs);
  if (!argsResult.success) {
    status = "failed";
    errorMessage = `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`;
    errorKind = "args_invalid";
    thrown = new Error(errorMessage);
  } else {
    recordedArgs = argsResult.data;
    try {
      const fixtures = await buildStepFixtures(contextHandle.ctx, fixtureNames);
      contextHandle.beginStepRun(step, fixtures);
      const runResult = await step.run(fixtures, argsResult.data);
      const returnsResult = step.returns.safeParse(runResult);
      if (!returnsResult.success) {
        status = "failed";
        errorMessage = `returns validation failed: ${formatValidationIssues(returnsResult.error.issues)}`;
        errorKind = "result_invalid";
        thrown = new Error(errorMessage);
      } else {
        status = "ok";
        result = returnsResult.data;
      }
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      errorKind = "step_error";
      thrown = error;
    }
  }

  const observed = contextHandle.observedCounts();
  const sections = contextHandle.sectionsSnapshot();
  const calls = contextHandle.callsSnapshot();
  const polls = contextHandle.pollsSnapshot();
  const requiredEnv = contextHandle.envReadsSnapshot();
  const used = contextHandle.usedSnapshot();
  const pageEvents = contextHandle.pageEventsSnapshot();
  const httpOmitted = contextHandle.httpOmittedSnapshot();
  const evidenceSnapshot = await contextHandle.evidenceSnapshot();

  const finishedAt = new Date();

  let disposeResult: DisposeResult;
  try {
    disposeResult = await contextHandle.dispose();
  } catch {
    // Same backstop cli/do.ts's own dispose() catch keeps: no evidence file
    // is known to exist in that case, so none is listed.
    disposeResult = { evidence: { screenshots: [] }, storageState: undefined };
  }
  const { evidence } = disposeResult;
  // No trace-actions to merge in here (this file's own header: a browser
  // never launches through this module), so only `evidenceSnapshot`'s own
  // truncation ever contributes.
  const truncated = mergeTruncated(undefined, evidenceSnapshot.truncatedCount);

  const stepRecord: StepRecord =
    status === "ok"
      ? {
          step_record_id: recordId,
          step: name,
          kind: "external",
          // `recordedArgs`, not the caller's own `args` parameter: the same
          // "the record's own `args` is what actually ran, `use`-filled
          // keys included, schema-validated" rule `nuka do` follows for its
          // own `recordedArgs` (src/cli/do.ts) — a chained key both lands
          // here *and* is named in `used`, below, which is exactly the
          // pairing `nuka harvest` reads to tell a chain apart from a
          // literal.
          args: recordedArgs,
          result,
          status: "ok",
          environment: DEFAULT_ENVIRONMENT_NAME,
          session: null,
          scenario_record_id: null,
          run_id: null,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          evidence: {
            dir: relativeDir,
            ...evidence,
            ...(evidenceSnapshot.attachments.length > 0 ? { attachments: evidenceSnapshot.attachments } : {}),
          },
          observed,
          mutates: step.mutates,
          ...(used.length > 0 ? { used: omitUsedResults(used) } : {}),
          ...(sections.length > 0 ? { sections } : {}),
          ...(calls.length > 0 ? { calls } : {}),
          ...(polls.length > 0 ? { polls } : {}),
          ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
          ...(pageEvents ? { page_events: pageEvents } : {}),
          ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
          ...(truncated !== undefined ? { truncated } : {}),
        }
      : {
          step_record_id: recordId,
          step: name,
          kind: "external",
          // Same reasoning as the `status === "ok"` branch above.
          args: recordedArgs,
          error: { message: errorMessage, kind: errorKind ?? "step_error" },
          status: "failed",
          environment: DEFAULT_ENVIRONMENT_NAME,
          session: null,
          scenario_record_id: null,
          run_id: null,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          mutates: step.mutates,
          evidence: {
            dir: relativeDir,
            ...evidence,
            ...(evidenceSnapshot.attachments.length > 0 ? { attachments: evidenceSnapshot.attachments } : {}),
          },
          observed,
          ...(used.length > 0 ? { used } : {}),
          ...(sections.length > 0 ? { sections } : {}),
          ...(calls.length > 0 ? { calls } : {}),
          ...(polls.length > 0 ? { polls } : {}),
          ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
          ...(pageEvents ? { page_events: pageEvents } : {}),
          ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
          ...(truncated !== undefined ? { truncated } : {}),
        };

  // Redacted once, as one object, the same "record.json and every other
  // exit must never disagree about what got redacted" rule cli/do.ts
  // follows — this module's own return value (below) is deliberately built
  // from the *unredacted* `result`, not from this object (this file's own
  // header).
  const redactedStepRecord = redact(stepRecord, secrets) as StepRecord;
  await writeStepRecord(evidenceDir, redactedStepRecord);

  if (status === "failed") {
    throw thrown;
  }
  return { result: result as z.infer<TReturns>, stepRecordId: recordId };
}
