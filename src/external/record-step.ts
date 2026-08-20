import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { APIRequestContext } from "playwright";
import type { z } from "zod";
import { formatValidationIssues } from "../binding/format-issues.js";
import { loadConfig } from "../config/load-config.js";
import { BUILTIN_FIXTURE_NAMES } from "../context.js";
import { buildStepFixtures, createStepContext, type DisposeResult } from "../context/create-context.js";
import { loadEnvFiles } from "../context/env.js";
import { mergeTruncated } from "../context/evidence.js";
import { omitUsedResults } from "../context/used.js";
import { DEFAULT_ENVIRONMENT_NAME } from "../environment/resolve-environment.js";
import { generateStepRecordId } from "../record/record-id.js";
import type { ErrorKind, StepRecord } from "../record/types.js";
import { writeStepRecord } from "../record/write-step-record.js";
import { buildSecretSet } from "../secrets/build-secret-set.js";
import { classifyEnvFiles } from "../secrets/classify-env-files.js";
import { redact } from "../secrets/redact.js";
import type { Step } from "../step/define-step.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";

// Responsibility: run one typed step from inside a Playwright Test spec and
// write the same step record shape `nuka do` writes (docs/spec.md "The
// second door"), so a spec run this way accumulates records `nuka harvest`
// can turn into a feature draft, closing the gap that door's own doc
// comment names: "What does not cross is the record... there is no
// executor in that home." This module is that home's executor, on the one
// slice it drives (a typed step's own `args`/`returns` schemas, `request`),
// not a general Playwright fixture wrapper.
//
// `stepFixtureNames(step)` (its transitive closure over `parts`) is
// checked against `SUPPORTED_FIXTURE_NAMES`, below, before any record
// exists: a step that names `page`/`context` would otherwise reach
// `ctx.page()`, lazily launch a browser this module has no Playwright page
// to hand it, and write a trace.zip that duplicates evidence the calling
// spec's own Playwright run already owns (docs/spec.md "The second door"'s
// own arrow diagram: this module must not become a second, competing
// evidence source). Refusing before `recordId`/`evidenceDir` exist matches
// `nuka do`'s own setup-phase refusals (src/cli/do.ts): a step whose
// fixtures cannot be built here never began, so no record is cited for it.
// A custom `config.fixtures` name fails the same check for a related but
// different reason: nothing here resolves `config.fixtures` at all yet
// (only the closed, no-browser subset of `StepFixtures` is built), so a
// name outside that subset is refused the same way regardless of why it
// isn't supported.
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
// EXPERIMENTAL, marked by name (`experimental_` first, matching
// `experimental_callWebmcpTool`'s own convention — src/webmcp/call-tool.ts)
// rather than by a runtime flag, for the reason that module's own header
// gives: the whole point is that a caller cannot reach this surface
// without typing the word. Remove the prefix only once both of these hold:
//   - an injected `page` (not only `request`) is supported, so a step
//     whose fixtures include a browser resource is no longer refused
//     outright by this module
//   - the API shape above (three exported names, one call site) has run
//     unchanged against a real Playwright Test suite migrated this way,
//     not only against this package's own tests

/** Every `StepFixtures` name this module can build without a browser page
 * (`BUILTIN_FIXTURE_NAMES`, src/context.ts, minus `page`/`context`) — see
 * this file's own header for why a name outside this set is refused before
 * any record exists. */
const SUPPORTED_FIXTURE_NAMES = new Set(
  BUILTIN_FIXTURE_NAMES.filter((name) => name !== "page" && name !== "context"),
);

/** Thrown when `step`'s own fixture needs (its `run`'s destructured names,
 * closed transitively over `parts`) include a name this module cannot
 * build — `"page"`/`"context"` (no injected browser page yet, this file's
 * own header) or a `config.fixtures` entry (not resolved here). Thrown
 * before `recordId`/`evidenceDir` exist, so no step record is written for
 * it: the execution never began. */
export class UnsupportedExternalFixtureError extends Error {
  readonly fixtureName: string;

  constructor(fixtureName: string) {
    super(
      `experimental_recordStep cannot build fixture "${fixtureName}": only ` +
        `${[...SUPPORTED_FIXTURE_NAMES].sort().join(", ")} are available without an injected browser page. ` +
        `"page"/"context" need a Playwright page, not supported yet; any other name is a config.fixtures ` +
        `entry, which this experimental function does not resolve.`,
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
 * `options.rootDir`'s state directory. Reuses `options.request` rather than
 * launching one of its own — see `CreateStepContextOptions.request`
 * (src/context/create-context.ts) for why closing it is never this
 * module's job.
 *
 * @throws {UnsupportedExternalFixtureError} `step`'s own fixture needs (or
 * any of its `parts`') name `page`/`context`, or a `config.fixtures` entry
 * — before any step record is written.
 * @throws {Error} `args` failed `step.args`, or `step`'s own return value
 * failed `step.returns` — after a `status: "failed"` step record is
 * written.
 * Also rethrows whatever `step.run` itself threw, unchanged, after writing
 * the same kind of failed record.
 */
export async function experimental_recordStep<TArgs extends z.ZodTypeAny, TReturns extends z.ZodTypeAny>(
  step: Step<TArgs, TReturns>,
  args: z.input<TArgs>,
  options: ExperimentalRecordStepOptions,
): Promise<ExperimentalStepExecution<TReturns>> {
  const { name, rootDir, request } = options;

  const fixtureNames = stepFixtureNames(step);
  for (const fixtureName of fixtureNames) {
    if (!SUPPORTED_FIXTURE_NAMES.has(fixtureName)) {
      throw new UnsupportedExternalFixtureError(fixtureName);
    }
  }

  const config = await loadConfig(rootDir);
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
  let status: "ok" | "failed";
  let result: unknown;
  let errorMessage = "";
  let errorKind: ErrorKind | undefined;
  // The exact value this function throws once the step record below is
  // written — a fresh `Error` for a schema failure, or `step.run`'s own
  // thrown value, unchanged, for a step_error (this file's own header).
  let thrown: unknown;

  const argsResult = step.args.safeParse(args);
  if (!argsResult.success) {
    status = "failed";
    errorMessage = `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`;
    errorKind = "args_invalid";
    thrown = new Error(errorMessage);
  } else {
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
          args,
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
          args,
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
