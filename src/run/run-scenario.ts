import { RUN_FILE_DIRS, runRelativeDir, scenarioRelativeDir, stepRecordRelativeDir } from "../record/state-layout.js";
import { SCHEMA_VERSIONS } from "../record/schema-version.js";
import { formatFinding, withoutWarningPrefix } from "../finding/finding.js";
import { runCodeInfo } from "../finding/run-codes.js";
import { readOwnVersion } from "../version.js";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  TimeConversion,
  type GherkinDocument,
  type Pickle,
  type PickleStep,
  type Step as GherkinStep,
} from "@cucumber/messages";
import type { z } from "zod";
import { formatValidationIssues } from "../issues/format-issues.js";
import type { CheckedPattern } from "../check/binding-check.js";
import {
  declaresDoneCallback,
  doneCallbackMessage,
  SCENARIO_HOOK_ARG_COUNT,
} from "../check/done-callback.js";
import { createStepTextMatcher } from "../check/feature-check.js";
import { checkFromOrder, isHeldBackByUndefinedLine } from "../check/from-order.js";
import { checkUnfillableKeys } from "../check/unfillable-key.js";
import { DataTable } from "../compat/data-table.js";
import {
  createDeclaredCollector,
  setActiveDeclaredCollector,
  type DeclaredCollector,
} from "../compat/declared.js";
import type { HookParameter, HookRegistration } from "../compat/hooks.js";
import { hookApplies } from "../compat/tag-expression.js";
import type { InstantiatedWorld } from "../compat/world.js";
import type { WorldView } from "../program/world-view.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext } from "../step/context.js";
import { createStepContext, type DisposeResult } from "../context/create-context.js";
import { evidenceMetaFields, mergeTruncated } from "../context/evidence.js";
import { collectTraceEvidence, traceFileFields, type TraceEvidence } from "../context/trace-actions.js";
import { omitUsedResults } from "../context/used.js";
import { ReadOnlyEnvironmentError } from "../environment/resolve-environment.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { FixtureGraph } from "../fixture/graph.js";
import {
  createFixtureCache,
  teardownFixtureCache,
  type CachedFixture,
  type FixtureCache,
  type FixtureInstance,
  type FixtureTeardownError,
} from "../fixture/resolver.js";

export type { CachedFixture, FixtureInstance };
import { runOnce, type ProcessSignal } from "./process-signal.js";
import { classifyCaughtError, runWithTimeout } from "./step-deadline.js";
import { createRecordDir, generateStepRecordId } from "../record/record-id.js";
import type { ArgOrigin, ErrorKind, FixtureUsageEntry, StepRecord } from "../record/types.js";
import { readStepRecord } from "../record/read-step-record.js";
import { writeStepRecord } from "../record/write-step-record.js";
import { redact, redactString, fixtureTeardownWarning } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import type { FixtureOutcome } from "../step/fixture-types.js";
import { malformedFromEntryMessage, tryFromCandidates, type Step } from "../step/define-step.js";
import { strictArgsSchema } from "../step/strict-args.js";
import { argOrigins, claimArgSide, sentenceTextOf } from "./arg-origins.js";
import { runValidatedStep, snapshotClaimArgs, type ClaimExecution } from "./execute-typed-step.js";
import { channelsOfStepRecord, recordedChannels, withMeasured } from "./measured.js";
import { gherkinStepLines, pickleStepLines } from "./run-document.js";
import { bindStepArgs, matchPickleStep, type StepBinding } from "./match-step.js";
import type { GitState } from "./probe-git.js";
import type { StepProgressInfo } from "./progress-log.js";
import {
  type AfterStepEndCounts,
  hookDisplayTitle,
  type ScenarioHookRecord,
  type ScenarioRecord,
  type ScenarioStepEntry,
} from "../record/scenario-record.js";
import { generateScenarioId } from "./scenario-id.js";

// Responsibility: execute one pickle end to end — the scenario-level
// counterpart to cli/do.ts's execution
// phase. One `ctx` is created for the whole pickle and shared by every step
// (docs/spec.md "Running": "Steps in one pickle share one context"); a
// step's own failure/undefined/ambiguous stops matching or running any
// further step in this scenario, but every step still gets a scenario-record
// entry (`skipped` for the rest). Evidence follows its natural scope: the
// browser's
// trace/screenshots belong to the scenario as a whole (one `dispose()` call,
// at the very end), while each step's own http.jsonl belongs to that step's
// own step record dir — reached by calling `contextHandle.beginStep` right
// before running each step that begins execution.
//
// The two "never began" outcomes (undefined, ambiguous) are resolved
// *before* a step record id or directory is created — matching docs/spec.md
// "an execution that never began must not be citable". Every other failure
// (binding, args validation, the step's own throw, returns validation)
// happens *after* that point and therefore always gets a failed step record,
// mirroring `nuka do`'s own setup/execution split.
//
// A Then-position (`PickleStepType.OUTCOME`) step's own execution is never
// judged by what it observed on the wire: this file used to demote an
// otherwise-"passed" status when a Then-bound step's
// execution measured a network write, but the write/read-method proxy that
// measurement rests on is not the semantics itself — GraphQL, RPC-over-POST,
// and many vendor query APIs run a semantically pure read through POST, and
// nukadoko has no way to tell those apart from the HTTP layer alone. A
// step's own `mutates` declaration is what nukadoko trusts instead; `nuka
// check`'s static check (src/check/feature-check.ts) still warns when a
// declared-mutating step is bound in Then position, but nothing in this file
// enforces it at runtime any more — the step just runs like any other.
//
// `policy: "read-only"` enforcement closes a gap this file always had:
// unlike cli/do.ts, `nuka run` never
// looked at the resolved environment's policy at all. Only the declared half
// of that check remains (same reasoning as
// the Then-position paragraph above): a step whose *declared* `mutates` is
// `true` is refused before it ever runs — a "never began" outcome, alongside
// undefined/ambiguous, with `step_record_id: null` and the rest of the scenario
// skipped. There is no longer a measured backstop for a step that declares
// `mutates: false` yet is observed writing anyway: `observed` still
// lands on the step record (docs/spec.md
// "Records"), it just no longer decides `status`; a wrong declaration stays
// visible there and in http.jsonl for a report to catch, rather than failing
// the run that exposed it.
//
// `ctx.resultOf`: this file is the
// one place a pickle's result chain is held — a `Map` keyed by the Step
// object itself (not by name), updated only when a step's own status is
// `"passed"`. The chain is created fresh per scenario and never escapes this
// function, so it cannot leak between
// pickles; a step's own reader is wired into createStepContext's `resultOf`
// option as a plain closure over this map, and every value-returning read is
// reflected back afterward via `contextHandle.usedSnapshot()` onto that
// step's own step record (`used`). Only a *typed* step's chain key ever exists
// (compat has no Step object, and no validated result to offer — see below),
// so this chain is exclusively typed-to-typed provenance, unchanged by
// compat support (v1 builds no data bridge between compat and
// typed interop).
//
// Object identity survives a step file importing another step file:
// src/discover/discover-steps.ts loads
// every file through one namespace for the whole discovery run, so a step file's own relative import of another step
// file's default export is the same object discovery put in this chain's
// key space. See tests/resultof.test.ts's header comment for the
// empirical proof this relies on.
//
// This file also runs compat steps and Before/After hooks, closing two gaps
// where compat lagged typed steps: `buildStepBindings`/`matchPickleStep`
// (src/run/match-step.ts) already matched through compat entries, but this
// file is where a *matched*
// compat entry now actually executes instead of being skipped. One World
// is constructed per pickle ("1 pickle = 1 World = 1 ctx"), shared
// by every compat step and hook in it, wrapping the exact same `ctx`
// (`contextHandle.ctx`) a typed step's own `request`/`page` fixtures are
// resolved from (`buildStepFixtures`) — so a
// typed step's `request` fixture and a compat step's `this.request` (after
// `await this.openRequest()`) are the identical Playwright object, cookies
// and all. A compat step's own
// execution is much simpler than a typed step's: no args/returns schema,
// so no binding-failure branch and no `chain` entry ever gets written for
// one (`result: null` always, per docs/spec.md "Records": "Compat steps
// record result: null" — regardless of what the glue function itself
// returned). Before/After hooks run against that same World, outside any
// step's own step record boundary — `contextHandle.beginStep(scenarioDir, ...)`
// before each individual hook invocation redirects http.jsonl logging and
// the `observed` tally away from any step's own step record dir. http.jsonl and
// `observed` stay scenario-wide and
// un-attributed to any one hook invocation, a documented v1 limit rather
// than a bug (neither is measured on, or visible from, any single
// `ScenarioHookRecord` entry) — but a hook invocation's own trace chunk and
// `actions` are not: that half of the gap is closed, giving
// each individual Before/After/AfterStep call that touches the browser its
// own isolated trace, the same per-invocation boundary `declaredCollector`
// (below) already had.
//
// This file also owns `declaredCollector` (src/
// compat/declared.ts) — one per pickle, repointed as "the currently active
// declared collector" right after `instantiateCompatWorld` runs, and reset
// via its own `beginStep(dir)` at the same points `contextHandle.beginStep`/
// `worldInstrumentation.beginStep` already are: once per step (redirected to
// that step's own step record dir) and once per *individual* Before/After hook
// invocation (redirected to `scenarioDir`, read right after that hook
// returns/throws) — kind-independent (a typed step's step record gets this
// exactly like a compat step's does, since both the registered allure-js
// `TestRuntime` and a compat World's own attach/log/link read the same
// active pointer).
//
// This file closes gaps where compat step/hook execution silently diverged
// from cucumber-js's own semantics — a compat step's or hook's own
// `{ timeout }` is now actually
// enforced (`runWithTimeout`), every Before/After hook is called
// with a real `HookParameter` instead of zero arguments (`buildHookParameter`),
// and a string return of `"pending"`/`"skipped"` or an apparent
// `done`-callback arity both fail loudly instead of silently passing —
// all four checks apply only to compat steps and hooks, never to a
// typed step, whose fixed `run(fixtures, args)` arity and zod-validated
// `returns` make none of cucumber-js's own conventions here relevant to it.
//
// `defaultTimeoutMs` (this run's own
// `setDefaultTimeout` value, or `undefined`) is threaded in from cli/run.ts
// and falls back only where a compat step's/hook's *own* `{ timeout }` is
// `undefined` (`?? defaultTimeoutMs` at each `runWithTimeout` call site
// below): an own declaration always wins, matching cucumber-js. `undefined
// ?? undefined` stays `undefined`, so never calling `setDefaultTimeout`
// leaves every compat step/hook exactly as unbounded as it always was.
// A negative number is the same absence of a limit: cucumber-js arms a
// timer only for zero or greater, and `setDefaultTimeout(-1)` is how a
// suite turns the limit off. `runWithTimeout` applies that only for the
// compat source. Zero still arms a timer.
// `runWithTimeout`/`pendingOrSkippedMessage`/`doneCallbackMessage` are
// exported (unchanged otherwise) so cli/run.ts's own BeforeAll/AfterAll
// execution (a run-scope hook, not a per-pickle
// one, so it does not belong in this file) reuses the exact same
// timeout-racing/message logic rather than a second, drifting copy of it.
//
// `runId` and `git` are both computed once by
// the caller (cli/run.ts), before this run's own pickle loop, and threaded
// into every `runScenario` call unchanged — the same "measured once per
// run, not once per pickle" shape `targetVersion` above already has. This
// file only ever copies them onto each scenario record it writes.
//
// `runAfterStepHooks` (defined just
// above the pickle.steps loop it's called from) adds `AfterStep` execution —
// once per pickle step that actually ran, not once per scenario the way
// Before/After are — with the exact same non-breaking failure handling the
// After loop above already has (see that function's own header). Only a
// step that actually executed reaches it; a skipped/never-began step does
// not.
//

/** One pickle's own result chain: which Step object most recently finished
 * with `status: "passed"`, and what its validated result, step record id, and
 * own step name were. `stepName` is carried alongside `recordId` so a `used`
 * entry built from this chain — whether through `ctx.resultOf` or a `from`
 * injection — can cite the step name docs/spec.md "Records" asks for
 * without a second vocabulary lookup. */
interface ChainEntry {
  readonly result: unknown;
  readonly recordId: string;
  readonly stepName: string;
}


export interface RunScenarioOptions {
  readonly rootDir: string;
  readonly config: NukadokoConfig;
  /** The world this scenario runs against: its URL is the base URL every
   * page and request resolves against, and its name goes on each step
   * record. `null` when the tree has no program file. Not the compat
   * World, which this file calls `world`. */
  readonly programWorld: WorldView | null;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
  /** This pickle's own feature file, already parsed (src/feature/load-
   * features.ts's `parseFeatureSource`) — every Before/After hook's
   * `HookParameter.gherkinDocument`
   * below is this exact object, never a partial/reconstructed stand-in. */
  readonly gherkinDocument: GherkinDocument;
  readonly vocabulary: Vocabulary;
  readonly bindings: readonly StepBinding[];
  /** The same `CheckedPattern[]` `nuka check` builds via
   * src/check/binding-check.ts's `checkBindings` (cli/run.ts's own setup
   * phase calls it once for the whole run, not once per pickle) — this
   * pickle's own from-order guard (below) resolves each of its steps' bound
   * names through these, the exact seam `src/check/from-order.ts`'s own
   * header explains (`nuka check` and
   * `nuka run` share one judgment, never two). */
  readonly patterns: readonly CheckedPattern[];
  /** This `nuka run` invocation's own id — generated once by the caller
   * (cli/run.ts), before any
   * pickle runs, and copied verbatim onto every scenario record this
   * invocation writes (`ScenarioRecord.run_id`). */
  readonly runId: string;
  /** The commit and cleanliness of the working tree when this run started
   * — probed once by the
   * caller (`src/run/probe-git.ts`), before any pickle runs, and copied
   * verbatim onto every scenario record this invocation writes
   * (`ScenarioRecord.git`). `undefined` outside a git repository or when
   * the probe itself failed; never causes this run to fail. */
  readonly git: GitState | undefined;
  readonly environment: string;
  /** The resolved environment's `policy` (cli/run.ts's `resolvedEnv.policy`)
   * — `"read-only"` refuses a declared-mutating step before it runs;
   * `undefined` means no restriction. A step
   * declared `mutates: false` that is nonetheless measured writing is no
   * longer demoted for it — the
   * declaration is trusted, and `observed` on its step record is
   * where a wrong one stays visible instead. */
  readonly policy: "read-only" | undefined;
  readonly targetVersion: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: SecretSet;
  /** Constructs this pickle's own World (src/discover/discover-steps.ts's
   * `DiscoveryResult.instantiateCompatWorld`), already wrapped for
   * measurement + this run's own `defineWorld`
   * schemas, with its `attach`/`log`/
   * `link` wired to the given declared collector. Called exactly once per
   * pickle, with this function's own
   * freshly created `declaredCollector` and with `config.worldParameters`
   * as `parameters` (the only declaration of that object). */
  readonly instantiateCompatWorld: (
    ctx: StepContext,
    declaredCollector: DeclaredCollector,
    parameters: Readonly<Record<string, unknown>>,
  ) => InstantiatedWorld;
  /** One line when this pickle's World cannot be constructed. The caller
   * owns stderr (a worker turns the same line into a note). Optional so a
   * caller that only wants the failed record can omit it. A throw from
   * construction must not escape this function: the caller's loop is what
   * runs the remaining scenarios and finalizes exports. */
  readonly onWorldSetupFailure?: (message: string) => void;
  /** Every registered Before/After hook (src/discover/discover-steps.ts's
   * `DiscoveryResult.compatHooks`) — already validated for tag-expression
   * support by the caller (cli/run.ts's setup phase); this file only
   * filters by this pickle's own tags. */
  readonly compatHooks: readonly HookRegistration[];
  /** This run's own `setDefaultTimeout` value (src/discover/discover-
   * steps.ts's `DiscoveryResult.defaultTimeoutMs`), or `undefined` if it was
   * never called — applied as the
   * fallback for a compat step's or Before/After hook's own `timeoutMs`
   * wherever that is `undefined`; an own declaration always wins. Not
   * applied to a typed step, which has no timeout mechanism at all. */
  readonly defaultTimeoutMs: number | undefined;
  /** Reports a trace format version this build cannot read — one instance
   * per `nuka run`
   * invocation (`src/context/trace-actions.ts`'s `createTraceVersionWarner`,
   * built once by cli/run.ts and passed unchanged into every
   * `runScenario` call for that invocation), so a run whose several steps
   * each hit this still only ever writes the stderr warning once. */
  readonly onUnknownTraceVersion: (version: number) => void;
  /** Reports one pickle step's own outcome the moment it stops running —
   * one instance per `nuka run`
   * invocation (src/run/progress-log.ts's `createStepProgressLogger`, built
   * once by cli/run.ts, same "build once, thread unchanged into every
   * runScenario call" shape `onUnknownTraceVersion` above already has).
   * `undefined` under `nuka do` (which has no scenario,
   * hence no `runScenario` call at all, hence nothing to wire this into).
   * Called from exactly one place in this file, `pushStepRecord` below —
   * see that function's own header for why every step-record append site
   * funnels through it instead of calling this directly. */
  readonly onStepEnd?: (info: StepProgressInfo) => void;
  /** The fixture dependency graph for this run
   * — builtins ∪ `config.fixtures`, built once by cli/run.ts's own setup
   * phase (`src/fixture/graph.ts`'s `buildFixtureGraph`) and passed
   * unchanged into every `runScenario` call, so every pickle in this
   * invocation resolves fixtures against the exact same graph `nuka check`
   * already validated before any of them ran. */
  readonly fixtureGraph: FixtureGraph;
  /** This whole `nuka run` invocation's own `"process"`-scope fixture cache
   * — created once by cli/run.ts, before the
   * first pickle, and passed unchanged into every `runScenario` call, so a
   * `"process"`-scope fixture named by more than one scenario is built
   * exactly once, by whichever scenario names it first, and reused by every
   * scenario after that. Torn
   * down once by cli/run.ts, after every scenario in the invocation has
   * finished — never here, since this function has no way to know it is
   * looking at the invocation's *last* pickle. */
  readonly fixtureProcessCache: FixtureCache;
  /** SIGINT/SIGTERM handler for this invocation, when the caller installed
   * one. This scenario registers its own teardown there for as long as the
   * scenario is in progress, so a signal during a step still tears the
   * scenario cache down and disposes the context. Omitted by a caller that
   * has no signal handler of its own. */
  readonly processSignal?: ProcessSignal;
}

/** The same message `nuka check`'s undefined-step finding carries, whose
 * `do` names the scaffold command for the file. */
function undefinedStepMessage(text: string): string {
  return `No step definition matches "${text}"`;
}

function ambiguousStepMessage(text: string, stepNames: readonly string[]): string {
  return `"${text}" matches more than one step: ${[...stepNames].sort().join(", ")}`;
}

// --- A step's own trace chunk
// is titled with its full gherkin text, keyword included ("Given the page is
// open"), so the chunk names itself the same way a reader would refer to the
// step. `pickleStep.text` alone never carries the keyword (gherkin's own
// pickle compiler strips it — the same reason src/report/allure/
// map-scenario.ts resolves it separately for its own step-name mapping); the
// only place left to read it is the original `GherkinDocument`, by walking
// from `pickleStep.astNodeIds[0]` back to the `Step` node that produced it.
// A small, local re-derivation rather than an import from map-scenario.ts:
// that module's own helpers are private, and even if they were not, src/
// report/** is out of this file's scope entirely.

function collectGherkinStepKeywords(doc: GherkinDocument): Map<string, string> {
  const keywords = new Map<string, string>();
  const addSteps = (steps: readonly GherkinStep[] | undefined): void => {
    for (const step of steps ?? []) {
      keywords.set(step.id, step.keyword);
    }
  };
  for (const child of doc.feature?.children ?? []) {
    addSteps(child.background?.steps);
    addSteps(child.scenario?.steps);
    for (const ruleChild of child.rule?.children ?? []) {
      addSteps(ruleChild.background?.steps);
      addSteps(ruleChild.scenario?.steps);
    }
  }
  return keywords;
}

/** `"Given the page is open"` — the keyword (trailing space already
 * included in gherkin's own `Step.keyword`) plus `pickleStep.text`, or the
 * bare text alone when the keyword can't be resolved (no astNodeIds, or an
 * id this pickle's own document doesn't have — should not happen for a
 * step that matched at all, but falling back rather than throwing keeps a
 * chunk title from ever being the reason a step fails). */
function stepChunkTitle(stepKeywords: ReadonlyMap<string, string>, pickleStep: PickleStep): string {
  const astNodeId = pickleStep.astNodeIds[0];
  const keyword = astNodeId !== undefined ? stepKeywords.get(astNodeId) : undefined;
  return keyword !== undefined ? `${keyword}${pickleStep.text}` : pickleStep.text;
}

// --- One trace chunk per individual
// Before/After/AfterStep *invocation*, isolated from every step's own chunk
// and from every sibling hook's — titled/named so a trace viewer (and a
// reader of the scenario evidence dir's own file listing) can tell one
// hook's chunk apart from a step's chunk and from another hook invocation's,
// the same way `stepChunkTitle` above already lets a step's chunk name
// itself. Matches src/report/summary/hook-label.ts's own wording
// ("Before hook" / "After hook" / "AfterStep hook (step N)") so the same
// invocation reads the same way in a trace viewer and in the run
// summary. ---

function hookChunkTitle(
  type: "before" | "after" | "after_step",
  name: string | undefined,
  stepIndex?: number,
): string {
  switch (type) {
    case "before":
      return hookDisplayTitle("Before hook", name);
    case "after":
      return hookDisplayTitle("After hook", name);
    case "after_step":
      return hookDisplayTitle(`AfterStep hook (step ${stepIndex})`, name);
  }
}

/** A non-empty `{ name }` is copied onto the hook record so a later reader
 * can title that one invocation. An empty string is not a title. */
function recordedHookName(name: string | undefined): { name: string } | Record<string, never> {
  if (name === undefined || name.length === 0) return {};
  return { name };
}

/** Unique within one scenario's own evidence dir — built from
 * `HookRegistration.registrationOrder` (src/compat/hooks.ts), which discovery
 * assigns once, globally, in registration order, so two hooks of the same
 * `type` can never collide. A `{ name }` is a title, not an identity: two
 * hooks may share one.
 * `stepIndex` is folded in for `"after_step"` only (mirroring
 * `ScenarioHookRecord.step_index`'s own "present only when `type` is
 * `after_step`" rule) — without it, the *same* AfterStep hook running after
 * two different steps would try to write two different chunks to the one
 * file name its own `registrationOrder` alone would produce. */
function hookChunkFileName(
  type: "before" | "after" | "after_step",
  registrationOrder: number,
  stepIndex?: number,
): string {
  switch (type) {
    case "before":
      return `hook-before-${registrationOrder}.zip`;
    case "after":
      return `hook-after-${registrationOrder}.zip`;
    case "after_step":
      return `hook-after_step-${stepIndex}-${registrationOrder}.zip`;
  }
}

// --- `from` injection (scenario path
// only — `nuka do` has no chain, docs/spec.md "Chaining steps": "Under
// `nuka do` there is no scenario and therefore no chain"). ---

/**
 * Fills `value`'s still-unfilled args keys from `step`'s own `from`
 * declaration, using this pickle's own chain:
 * capture always wins (a key `bindStepArgs` already put something in —
 * including from a table/docstring — is left untouched, `value[key] !==
 * undefined`), and a key whose upstream hasn't yet produced a successful
 * result *in this scenario* is left unfilled too — nukadoko never runs the
 * upstream step for you (docs/spec.md "Chaining steps": "One thing `from`
 * deliberately does not do: run the upstream step for you"), so a missing
 * dependency is a feature-file mistake to fix, not one this function papers
 * over.
 *
 * A key naming several candidate producers looks for whichever *one* of
 * them has a chain entry — the pre-
 * execution guard (`checkFromOrder`, called before this pickle's steps ever
 * run) already required exactly one candidate to be bound earlier, so this
 * function itself never *chooses* among candidates; it only ever finds zero
 * (upstream hasn't produced a result yet — the pre-existing case, generalized
 * to "none of the candidates has") or one. Finding two or more here would
 * mean that guard was bypassed or has a bug — not a case to resolve with a
 * rule: no first-found, no most-recent-across-different-
 * steps; fail loudly instead of inventing the priority docs/spec.md says
 * `from` deliberately does not have.
 *
 * Mutates `value` in place (the same object `began.rawArgs` already points
 * at — the step record's own `args` should show what the step
 * actually ran with, injected keys included — otherwise a reader could never
 * tell an injected value apart from one that was simply never validated).
 * Every key it *does* fill is reported to `recordUsed` — the same collector `ctx.resultOf` itself writes into, so a step
 * that is both injected into and separately calls `ctx.resultOf` still ends
 * up with one deduplicated `used` list. Every key it *cannot* fill is
 * returned (key -> the still-unfilled key's candidate step name(s), joined
 * when there is more than one, or a description of the problem if a
 * candidate was never itself named by `vocabulary` — see `stepNameOf`'s own
 * comment above) so the caller can name it if args validation goes on to
 * fail because of it — name which key, from which step.
 */
function injectFrom(
  value: Record<string, unknown>,
  step: Step,
  chain: ReadonlyMap<Step, ChainEntry>,
  stepNameOf: ReadonlyMap<Step, string>,
  recordUsed: (recordId: string, stepName: string, result: unknown) => void,
  // Told each key it filled, and from where: the step record's
  // `args_origin`.
  onFilled: (key: string, from: { step_record_id: string; step: string; key: string }) => void = () => undefined,
): Map<string, string> {
  const stillMissing = new Map<string, string>();
  for (const [key, entry] of Object.entries(step.from)) {
    if (value[key] !== undefined) {
      // Capture (or a table/docstring) already filled this key — `from`
      // only ever supplies a key the pattern itself left unfilled
      // (docs/spec.md "Chaining steps": "A
      // pattern capture still wins").
      continue;
    }
    const candidates = tryFromCandidates(entry);
    if (candidates === null) {
      throw new Error(malformedFromEntryMessage(key, entry));
    }
    const present = candidates.flatMap(([upstream, upstreamKey]) => {
      const chainEntry = chain.get(upstream);
      return chainEntry === undefined ? [] : [{ upstream, upstreamKey, chainEntry }];
    });

    if (present.length === 0) {
      const names = candidates.map(([upstream]) => stepNameOf.get(upstream) ?? "a step discovery never registered");
      stillMissing.set(key, names.join(" or "));
      continue;
    }
    if (present.length > 1) {
      // Unreachable in any scenario `checkFromOrder` has already passed —
      // see this function's own doc comment.
      throw new Error(
        `internal: from.${key} has more than one candidate producer's result available at once. ` +
          `nuka check's/nuka run's own from-order guard should have refused this scenario before ` +
          `execution began (docs/spec.md "Chaining steps")`,
      );
    }

    const { upstreamKey, chainEntry } = present[0]!;
    value[key] = (chainEntry.result as Record<string, unknown>)[upstreamKey];
    recordUsed(chainEntry.recordId, chainEntry.stepName, chainEntry.result);
    onFilled(key, { step_record_id: chainEntry.recordId, step: chainEntry.stepName, key: upstreamKey });
  }
  return stillMissing;
}

/** The step record's `args_origin` field, or nothing when there are no
 * keys to name. */
function optionalArgsOrigin(origins: Record<string, ArgOrigin> | undefined): { args_origin?: Record<string, ArgOrigin> } {
  return origins === undefined ? {} : { args_origin: origins };
}

/**
 * Names which still-missing `from` key(s) actually caused `issues` — not
 * every key `injectFrom` couldn't fill is
 * necessarily why args validation failed (an unfilled *optional* key is not
 * a zod issue at all), so this only speaks up for a key zod itself flagged.
 * `""` when there is nothing to add, so callers can simply append this to
 * the existing message unconditionally.
 */
function fromInjectionHint(
  issues: readonly z.core.$ZodIssue[],
  stillMissing: ReadonlyMap<string, string>,
): string {
  if (stillMissing.size === 0) {
    return "";
  }
  const issueKeys = new Set(issues.map((issue) => String(issue.path[0])));
  const named = [...stillMissing.entries()].filter(([key]) => issueKeys.has(key));
  if (named.length === 0) {
    return "";
  }
  const parts = named.map(
    ([key, stepName]) => `"${key}" should come from step "${stepName}" (must run earlier in this scenario)`,
  );
  return ` (${parts.join("; ")})`;
}

// --- Compat step/hook
// execution honesty (only compat entries and Before/After hooks —
// this audit is entirely about hand-written, cucumber-js-style glue;
// a typed step's `run(fixtures, args)` has a fixed arity and a zod-validated
// return, so none of these three checks apply to one). ---

/** cucumber-js interprets the string returns `"pending"`/`"skipped"`
 * as their own outcomes; nukadoko's step/scenario record schema has no such status
 * (implementing it for real is out of scope here), so
 * rather than silently passing through as success, a step/hook that returns
 * one of these two strings is failed with a message a migrator can act on.
 * Exported so cli/run.ts's own
 * BeforeAll/AfterAll execution reports the exact same wording for the exact
 * same fact, rather than a second copy of this message. */
export function pendingOrSkippedMessage(kind: "Step" | "Hook", name: string, value: string): string {
  return (
    `${kind} "${name}" returned ${JSON.stringify(value)}, which nukadoko does not interpret ` +
    `as pending/skipped (unlike cucumber-js). See docs/migration.md`
  );
}

// Re-exported so cli/run.ts and the worker entry keep importing the run
// failure's wording from this module. The sentence itself lives with the
// arity rule, which `nuka check` reports under the same words.
export { doneCallbackMessage };

// The deadline and the error classification live in step-deadline.ts, so
// the typed-step executor shares them without importing this module.
export { classifyCaughtError, runWithTimeout };

/** Builds this hook invocation's own `HookParameter`. `result` is included
 * only when `resultStatus` is set: cucumber-js never sets it for Before,
 * and sets it for After (the scenario so far) and AfterStep (that one
 * step). `details.includeError` matches that same split, and still sets
 * the `error` key when the value is `undefined`, because cucumber-js
 * assigns the key rather than omitting it. `pickleStep` and `testStepId`
 * are set only for AfterStep. `duration` comes from the milliseconds the
 * executor already measured for the step this result describes. */
function buildHookParameter(
  gherkinDocument: GherkinDocument,
  pickle: Pickle,
  testCaseStartedId: string,
  resultStatus: "PASSED" | "FAILED" | undefined,
  details: {
    readonly durationMs?: number;
    readonly message?: string;
    readonly error?: unknown;
    readonly includeError?: boolean;
    readonly pickleStep?: PickleStep;
    readonly testStepId?: string;
  } = {},
): HookParameter {
  return {
    gherkinDocument,
    pickle,
    testCaseStartedId,
    willBeRetried: false,
    ...(resultStatus !== undefined
      ? {
          result: {
            status: resultStatus,
            duration: TimeConversion.millisecondsToDuration(Math.max(0, details.durationMs ?? 0)),
            ...(details.message !== undefined ? { message: details.message } : {}),
          },
        }
      : {}),
    ...(details.includeError ? { error: details.error } : {}),
    ...(details.pickleStep !== undefined ? { pickleStep: details.pickleStep } : {}),
    ...(details.testStepId !== undefined ? { testStepId: details.testStepId } : {}),
  };
}

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioRecord> {
  const {
    rootDir,
    config,
    programWorld,
    pickle,
    relativeFeaturePath,
    gherkinDocument,
    vocabulary,
    bindings,
    patterns,
    runId,
    git,
    environment,
    policy,
    targetVersion,
    env,
    secrets,
    instantiateCompatWorld,
    onWorldSetupFailure,
    compatHooks,
    defaultTimeoutMs,
    onUnknownTraceVersion,
    onStepEnd,
    fixtureGraph,
    fixtureProcessCache,
    processSignal,
  } = options;

  // This pickle's own `"scenario"`-scope fixture cache — fresh per pickle,
  // unlike `fixtureProcessCache` above, and
  // torn down at this pickle's own end (below, before `contextHandle.
  // dispose()` — a scenario-scope fixture may itself hold `page`/`context`/
  // `request` and needs them still open during its own teardown code).
  const fixtureScenarioCache = createFixtureCache();

  const { id: scenarioId, dir: scenarioDir } = await createRecordDir(
    path.join(rootDir, runRelativeDir(config.stateDir, runId), RUN_FILE_DIRS.scenarios),
    generateScenarioId,
  );
  const relativeScenarioDir = scenarioRelativeDir(config.stateDir, runId, scenarioId);
  // This pickle's own step keywords, for each step's own trace chunk title
  // (this file's own header, just above) — built once per pickle, the same
  // "cheap, rebuilt per call" convention `stepNameOf` below already follows.
  const stepKeywords = collectGherkinStepKeywords(gherkinDocument);
  // The feature line of each step record this pickle wrote, so a claim that
  // reads a `from` value names the line that produced it
  // (`from:<step>@<line>.<key>`).
  const lineOfStep = pickleStepLines(pickle, gherkinStepLines(gherkinDocument));
  const recordLines = new Map<string, number>();

  const startedAt = new Date();

  // The pre-execution guard docs/spec.md
  // "Chaining steps" promises ("`nuka run`, before it executes that
  // scenario") — the exact judgment `nuka check` makes (src/check/from-
  // order.ts's own header), asked here before anything else in this pickle
  // happens. Deliberately placed before `chain`/`stepNameOf`/
  // `contextHandle`/the World are ever created, not merely before the
  // per-step loop below: a violation found anywhere in this pickle fails the
  // *whole* scenario without executing any of its steps, including ones
  // textually before the offending line — so no step's own `run` ever gets
  // a chance to call
  // `ctx.page()`, and this scenario's own browser session is never opened.
  // Every other pickle in this `nuka run` invocation is untouched (cli/
  // run.ts's own pickle loop calls this function once per pickle,
  // independently).
  //
  // `checkUnfillableKeys` (src/check/
  // unfillable-key.ts) joins `checkFromOrder` at this exact guard — same
  // judgment `nuka check` makes, same "never began" shape, one shared list of
  // per-step messages below rather than a second guard block.
  const match = createStepTextMatcher(patterns);
  // An issue behind a line that matches no step is the check's held-back
  // finding, not a verdict: under --no-check that line runs and fails as
  // undefined, which names the cause instead of a consequence of it.
  const orderIssues = checkFromOrder(pickle, vocabulary, match).filter((issue) => !isHeldBackByUndefinedLine(issue));
  const unfillableKeyIssues = checkUnfillableKeys(pickle, vocabulary, match);
  if (orderIssues.length > 0 || unfillableKeyIssues.length > 0) {
    // Mirrors the existing undefined-step shape (docs/spec.md "an execution
    // that never began must not be citable"): every pickle step still gets
    // its own `steps` entry, `step_record_id: null` throughout since nothing ever
    // began, and the scenario itself is `status: "failed"` like any other
    // failed scenario — cli/run.ts's own exit-code logic
    // (`record.status !== "passed"`) needs no change to reach the same
    // outcome for this new failure cause. The offending step(s) carry the
    // violation's own message(s) (joined, when one line has more than one
    // violated key, from either check); every other step — both before and
    // after, since none of them ran either — is `"skipped"`, the same status
    // a step already gets when an earlier one in its own pickle failed.
    const issuesByStepIndex = new Map<number, string[]>();
    for (const issue of [...orderIssues, ...unfillableKeyIssues]) {
      const messages = issuesByStepIndex.get(issue.stepIndex) ?? [];
      messages.push(issue.message);
      issuesByStepIndex.set(issue.stepIndex, messages);
    }
    const stepRecords: ScenarioStepEntry[] = pickle.steps.map((pickleStep, index) => {
      const messages = issuesByStepIndex.get(index);
      if (messages === undefined) {
        return { text: pickleStep.text, status: "skipped", step_record_id: null };
      }
      return {
        text: pickleStep.text,
        status: "failed",
        step_record_id: null,
        error: { message: messages.join("; ") },
      };
    });
    // Each line still gets its progress line, so stderr says which step
    // failed and why instead of a scenario line with nothing under it.
    stepRecords.forEach((entry, index) =>
      onStepEnd?.({
        stepIndex: index + 1,
        totalSteps: pickle.steps.length,
        status: entry.status === "failed" ? "failed" : "skipped",
        durationMs: 0,
        text: entry.text,
        errorMessage: entry.error === undefined ? undefined : redactString(entry.error.message, secrets),
        stepRecordId: null,
      }),
    );
    const finishedAt = new Date();
    const record: ScenarioRecord = {
      nukadoko: readOwnVersion(),
      scenario_record_id: scenarioId,
      run_id: runId,
      feature: relativeFeaturePath,
      scenario: pickle.name,
      line: pickle.location?.line ?? 0,
      status: "failed",
      environment,
      ...(targetVersion !== undefined ? { target_version: targetVersion } : {}),
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      steps: stepRecords,
      hooks: [],
      ...(git !== undefined ? { git } : {}),
      evidence: { dir: relativeScenarioDir, screenshots: [] },
    };
    const redactedRecord = redact(record, secrets) as ScenarioRecord;
    return redactedRecord;
  }

  // This scenario's own result chain — kept
  // here, not inside create-context.ts, so it never outlives this one
  // pickle's execution. `readChain` is the plain closure createStepContext
  // wraps into `ctx.resultOf`; this function is the only place that ever
  // writes to `chain`.
  const chain = new Map<Step, ChainEntry>();
  function readChain(step: Step): ChainEntry | undefined {
    return chain.get(step);
  }

  // Every typed step's own Step object, keyed by its vocabulary name — built
  // once per pickle from the same
  // `vocabulary` every pickle in this `nuka run` invocation shares. Doubles
  // as the "is this Step object one discovery actually registered" predicate
  // `ctx.resultOf`'s unregistered-Step throw needs (`stepNameOf.has`
  // answers exactly that question — a Step this map doesn't have a name for
  // is, by construction, not `===` anything discovery put in the vocabulary)
  // and as the name lookup a `from` injection's own "still missing" error
  // message uses to name which upstream step a key should have come
  // from, whether or not that step has run yet in this scenario.
  const stepNameOf = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      stepNameOf.set(entry.step, entry.name);
    }
  }

  const contextHandle = createStepContext({
    config,
    baseURL: programWorld?.url,
    evidenceDir: scenarioDir,
    rootDir,
    env,
    secrets,
    resultOf: readChain,
    isRegisteredStep: (step) => stepNameOf.has(step),
    stepNameOf: (step) => stepNameOf.get(step),
    // Closes the gap a part would otherwise open under a read-only
    // environment: the read-only branch below this only ever checks the
    // *entry* step's own declared `mutates`, so a step declared `mutates:
    // false` calling a part declared `mutates: true` was never checked at
    // all before `ctx.call` existed. Same message, same policy, only the
    // reachability path differs from the entry-step refusal below.
    refuseMutatingPart: (part) =>
      policy === "read-only" && part.mutates
        ? new ReadOnlyEnvironmentError(stepNameOf.get(part) ?? "a step discovery never registered", environment).message
        : undefined,
  });

  const stepRecords: ScenarioStepEntry[] = [];
  // Each written step record's count of actions its code started after the
  // record was written, live until the scenario record is built.
  const afterStepEnd = new Map<string, AfterStepEndCounts>();
  const hookRecords: ScenarioHookRecord[] = [];
  let scenarioFailed = false;
  // The outcome After reads. A passing scenario contributes the last
  // executed step's duration (cucumber-js's After `result` is a real step
  // result, and a pass still has a duration). The first failure wins,
  // message, duration, and thrown value, because later steps are skipped
  // and a later hook must not replace the failure that already failed the
  // scenario. `error` stays `undefined` when the failure was not a throw
  // (validation, an undefined step): the executor holds a message then,
  // not a thrown value.
  let passedDurationMs = 0;
  let heldFailure: { message: string; durationMs: number; error: unknown } | undefined;
  function noteFailure(message: string, durationMs: number, error: unknown): void {
    if (heldFailure === undefined) {
      heldFailure = { message, durationMs, error };
    }
  }
  // `"failed"` until every step and hook has settled. A signal during a
  // step reads this: the scenario did not finish, so `use()` gets `"failed"`.
  let scenarioOutcome: FixtureOutcome = "failed";
  const fixtureTeardownErrors: FixtureTeardownError[] = [];
  let disposeResult: DisposeResult = { evidence: { screenshots: [] } };
  // Shared with the signal handler (`runOnce`). Scenario fixtures tear
  // down before dispose: one built off `page`, `context`, or `request`
  // needs those still open. A teardown failure never changes
  // `scenarioFailed`. It lands on `ScenarioRecord.teardown_errors`, unless
  // the signal path is exiting and will not write that record, in which
  // case the warning goes to stderr here. This function has no stderr sink
  // of its own, and the CLI's stderr is the process stderr. The message is
  // the fixture's own text, so it is redacted here: the record that would
  // otherwise redact it is not written when the process is exiting.
  const tearDownScenario = runOnce(async () => {
    fixtureTeardownErrors.push(...(await teardownFixtureCache(fixtureScenarioCache, scenarioOutcome)));
    if (processSignal?.interrupted === true) {
      for (const teardownError of fixtureTeardownErrors) {
        process.stderr.write(
          formatFinding({
            severity: "warning",
            code: "fixture-teardown-failed",
            message: withoutWarningPrefix(fixtureTeardownWarning(teardownError.fixture, teardownError.message, secrets)),
            fix: runCodeInfo("fixture-teardown-failed").fix,
          }),
        );
      }
    }
    try {
      // No status argument: `dispose`'s own evidence no longer varies by
      // outcome, so there is nothing for this scenario's pass or fail to
      // select between.
      disposeResult = await contextHandle.dispose();
    } catch {
      // Same backstop as cli/do.ts: teardown failures must never take the
      // scenario record down with them.
      disposeResult = { evidence: { screenshots: [] } };
    }
  });
  processSignal?.setScenarioCleanup(tearDownScenario);

  /**
   * The one place this pickle's own `stepRecords` array is ever appended to
   * — every one of the seven places
   * below that used to call `stepRecords.push` directly now calls this
   * instead, so `onStepEnd` fires exactly once per step, by construction,
   * rather than by seven separate call sites staying in sync by discipline.
   * `durationMs` is `0` for a step that never actually executed
   * (skipped by an earlier failure, undefined, ambiguous, or refused by the
   * read-only policy) — there is no "how long did it take" for work that
   * never started; the two backstop call sites (a step that threw before or
   * after its own step record began) pass whatever real elapsed time they each
   * have. `stepIndex` is this array's own length right after the push, not
   * the pickle's own step index — the two agree under normal operation
   * (exactly one push per iteration of the loop below), and the array's own
   * length is what a progress-line reader actually wants: "which line is
   * this, out of how many so far", not a 0-based array position.
   *
   * `stepRecord` is the exact
   * in-memory object the two step-record-writing call sites already redacted
   * and wrote to disk, read here only for a failed step's `used` entries.
   * `null` for every other call site, none of which ever opened one at all.
   */
  function pushStepRecord(record: ScenarioStepEntry, durationMs: number, stepRecord: StepRecord | null = null): void {
    stepRecords.push(record);
    onStepEnd?.({
      stepIndex: stepRecords.length,
      totalSteps: pickle.steps.length,
      status: record.status === "passed" ? "passed" : record.status === "skipped" ? "skipped" : "failed",
      durationMs,
      text: record.text,
      // The in-memory entry is not redacted yet (the scenario record is,
      // when it is written), and this message goes straight to stderr.
      errorMessage: record.error === undefined ? undefined : redactString(record.error.message, secrets),
      stepRecordId: record.step_record_id,
      ...(stepRecord?.status === "failed" && stepRecord.used !== undefined ? { used: stepRecord.used } : {}),
    });
  }


  /**
   * A claim step's record fields (docs/spec.md "Claims"): each claim with
   * the channel its raw actual value was measured on, read from this
   * step's own channels for a value `observe` returned, or from the record
   * of the step that returned a `from` value.
   */
  function claimRecordFields(
    execution: ClaimExecution,
    begun: { readonly recordId: string; readonly recordDir: string },
    observed: StepRecord["observed"],
    httpLogExists: boolean,
    argsOrigin: Record<string, ArgOrigin> | undefined,
  ): Pick<StepRecord, "claims" | "observation" | "attempts" | "readings" | "readings_left_out"> {
    const claims = withMeasured(execution.judged, {
      ownRecordId: begun.recordId,
      ownChannels: recordedChannels({ observed, dir: begun.recordDir, ...(httpLogExists ? { http: "http.jsonl" } : {}) }),
      fromRecordOf: (key) => {
        const origin = argsOrigin?.[key];
        return typeof origin === "object" ? origin.from.step_record_id : null;
      },
      channelsOf: (id) => {
        const record = readStepRecord(path.join(rootDir, stepRecordRelativeDir(config.stateDir, runId, id)));
        return record === null ? [] : channelsOfStepRecord(rootDir, record);
      },
      secrets,
    });
    return {
      claims,
      observation: execution.observation,
      attempts: execution.attempts,
      ...(execution.readings === undefined ? {} : { readings: [...execution.readings] }),
      ...(execution.readingsLeftOut === undefined ? {} : { readings_left_out: { ...execution.readingsLeftOut } }),
    };
  }

  /**
   * Shared by the typed and compat branches below: records this
   * step in `chain` when `chainKey` is given and the final status is `"passed"`
   * (typed only — `undefined` for a compat step, since
   * a World is shared compat-to-compat only), then builds, redacts, and writes the
   * step record
   * and this step's own scenario-record entry. `observed` (every
   * channel this ctx records lands on whichever kind of step opened
   * it, typed or compat alike) is recorded on every step record below
   * regardless of position or policy, but no longer demotes `status` from it
   * (measurement stays a record, never a
   * verdict — see this file's own header). A closure over this function's
   * own `chain`/`contextHandle`/`environment`/`policy`/`targetVersion`/
   * `scenarioId`/`secrets`, and mutates the outer
   * `scenarioFailed`/`stepRecords` — kept as a nested function rather than
   * a free one specifically so it can reach all of that without threading
   * every one of those through its own parameter list.
   */
  async function finishExecutedStep(
    pickleStep: PickleStep,
    begun: { readonly recordId: string; readonly recordDir: string; readonly relativeRecordDir: string },
    stepStartedAt: Date,
    outcomeStepName: string,
    initialStatus: "passed" | "failed",
    initialErrorMessage: string,
    // `undefined` exactly when `initialStatus` is `"passed"` — a real `ErrorKind`
    // is required whenever the caller already knows this step failed for its
    // own reason (args/binding/returns/its own throw).
    initialErrorKind: ErrorKind | undefined,
    result: unknown,
    // For a typed step whose args validated, this is the schema-validated
    // value (`argsResult.data`), not the raw binding/`from` output — a step
    // record's own `args` must show what `run` actually received, matching
    // the JSON Schema `nuka describe` publishes for it (`strictArgsSchema`,
    // src/step/strict-args.ts). Raw whenever there is no validated value to
    // show instead: a binding/args-validation failure, or a compat step,
    // which has no `args` schema to validate against at all.
    recordedArgs: unknown,
    // Where each key of `recordedArgs` came from; `undefined` for a compat
    // step, whose arguments are positional.
    argsOrigin: Record<string, ArgOrigin> | undefined,
    chainKey: Step | undefined,
    // This step's own declared `mutates` (typed) or `null` (compat, which
    // has no declaration at all).
    mutates: boolean | null,
    // Every `config.fixtures` entry this step's own bag actually resolved —
    // `[]` for a compat step, which has no
    // fixture bag at all.
    fixtureUsage: FixtureUsageEntry[],
    // What a claim step read and judged; `undefined` for any other step,
    // and for a claim step that failed before it ran (binding or args).
    claimExecution: ClaimExecution | undefined = undefined,
  ): Promise<number> {
    const status = initialStatus;
    const errorMessage = initialErrorMessage;
    const errorKind = initialErrorKind;

    // Closes this step's own trace chunk, if one is open, *before* anything
    // below reads from `begun.recordDir` —
    // the reason this is a dedicated call rather than left to the next
    // `beginStep` (which only runs once the next step, or a hook boundary,
    // starts, well after this step's own step record is already written): a
    // step's own `evidence.trace` has to be knowable *now*, from this
    // step's own chunk having already been written to disk.
    // First, before the trace chunk closes: the step boundary is the
    // moment its `run` returned, and a body still arriving belongs to it
    // for at most the flush's second.
    const observed = await contextHandle.observedSnapshot();
    afterStepEnd.set(begun.recordId, contextHandle.afterStepEnd());
    await contextHandle.endStep();
    const traceEvidence = await collectTraceEvidence(begun.recordDir, onUnknownTraceVersion, "trace.zip", contextHandle.namedContexts());

    // `observed` is recorded every occurrence,
    // typed or compat alike, and always land on the step record below — this
    // is a record, not a verdict: nukadoko no
    // longer demotes `status` for what a step's execution measured, whether
    // that step is bound in Then position or running under a read-only
    // policy. What's left of that enforcement is entirely declared: the
    // read-only refusal above (before this step ever ran) and `nuka
    // check`'s static Then-position warning, neither of which this function
    // touches.
    const usedEntries = contextHandle.usedSnapshot();
    // Labels `ctx.section` was called with since the current step boundary
    // began — reset at the same
    // `beginStep` calls `observed`/`used` already are, so a step never
    // inherits an earlier step's labels in this shared-`ctx` pickle.
    const sectionLabels = contextHandle.sectionsSnapshot();
    // Every `ctx.call(part, args)` invocation made directly by this
    // execution, read the same "after execution, whatever the outcome" way
    // `sectionLabels` right above is — always empty for a compat step,
    // which has no `call` counterpart on `this`, the same way `sections` is.
    const callEntries = contextHandle.callsSnapshot();
    // Every `ctx.poll` call that finished since the current step boundary
    // began, in completion order — same
    // "read after execution, whatever the outcome" shape as `sectionLabels`
    // right above; a poll that timed out or whose `fn` threw is exactly the
    // record a failed step's step record needs.
    const pollRecords = contextHandle.pollsSnapshot();
    // Env var names `ctx.requireEnv` was called with since the current step
    // boundary began, including a call that went on to throw
    // `MissingEnvError` —
    // reset at the same `beginStep` call `observed`/`used`/`sections`
    // already are, so a step never inherits an earlier step's required
    // names in this shared-`ctx` pickle. Always empty for a compat step (no
    // `requireEnv` counterpart on `this`), so `required_env` is naturally
    // omitted for one below, the same way `sections` already is.
    const requiredEnv = contextHandle.envReadsSnapshot();
    // Console errors/uncaught page errors/failed requests the browser
    // context saw since the current step boundary began — same
    // "read after execution, whatever the outcome" shape
    // as `observed`/`sectionLabels`/`pollRecords`/`requiredEnv` above;
    // `undefined` when `ctx.page()` was never called this step, or was and
    // the page stayed clean.
    const pageEvents = contextHandle.pageEventsSnapshot();
    // How many page-issued requests since the current step boundary began
    // were left out of http.jsonl, by resourceType, read the same "after
    // execution, whatever the outcome" way `pageEvents` just above is —
    // `undefined` when nothing was
    // ever left out.
    const httpOmitted = contextHandle.httpOmittedSnapshot();
    const httpLogFailed = contextHandle.httpLogFailedSnapshot();
    // World reads/writes tallied since the current step boundary began —
    // always empty for a typed step (no
    // `this`), so the `world` field below is naturally omitted for one,
    // with no separate kind check needed.
    const worldReadsWrites = worldInstrumentation.snapshot();
    // What this step (kind-independent) declared through the allure-js
    // runtime shim or a compat World's own attach/log/link — `undefined`
    // when nothing was ever recorded
    // this step, omitted from the step record the same way `used`/`world` are.
    const declared = declaredCollector.snapshot();
    // Application-specific evidence `evidence.attach`/`.path` produced since
    // the current step boundary began — only a typed step's
    // fixture bag has `evidence`, so this is naturally empty for a compat
    // step, the same way `sections`/`polls` already are. Read the same
    // "after execution, whatever the outcome" way as every snapshot above.
    const evidenceSnapshot = await contextHandle.evidenceSnapshot();
    // Combines `traceEvidence`'s own `{ actions }` truncation with
    // `evidenceSnapshot`'s into the step record's single
    // top-level `truncated` field — see `mergeTruncated`'s own doc comment
    // (src/context/evidence.ts) for why this is one shared function rather
    // than two independent spreads.
    const truncated = mergeTruncated(traceEvidence.truncated, evidenceSnapshot.truncatedCount);

    // Only a step whose *final* status is "passed" ever becomes readable via
    // `ctx.resultOf`, and only when `chainKey` is given at all (typed only).
    if (status === "passed" && chainKey !== undefined) {
      chain.set(chainKey, { result, recordId: begun.recordId, stepName: outcomeStepName });
    }

    const stepFinishedAt = new Date();
    const httpLogExists = existsSync(path.join(begun.recordDir, "http.jsonl"));
    const claimFields = claimExecution === undefined ? {} : claimRecordFields(claimExecution, begun, observed, httpLogExists, argsOrigin);

    const stepRecord: StepRecord =
      status === "passed"
        ? {
            schema_version: SCHEMA_VERSIONS.step_record,
            nukadoko: readOwnVersion(),
            step_record_id: begun.recordId,
            step: outcomeStepName,
            kind: "run",
            args: recordedArgs,
            ...(argsOrigin !== undefined ? { args_origin: argsOrigin } : {}),
            result,
            status: "passed",
            environment,
            world_name: programWorld?.name ?? null,
            target_version: targetVersion,
            scenario_record_id: scenarioId,
            run_id: runId,
            started_at: stepStartedAt.toISOString(),
            finished_at: stepFinishedAt.toISOString(),
            evidence: {
              dir: begun.relativeRecordDir,
              screenshots: [],
              ...(httpLogExists ? { http: "http.jsonl" } : {}),
              ...traceFileFields(traceEvidence),
              ...evidenceMetaFields(evidenceSnapshot),
            },
            observed,
            mutates,
            // `omitUsedResults`: an
            // "passed" step record keeps `used`'s original `{ step_record_id, step }`
            // shape — the upstream's own result is only worth a second look
            // on a *failed* step record, the failed branch just below.
            ...(usedEntries.length > 0 ? { used: omitUsedResults(usedEntries) } : {}),
            ...(sectionLabels.length > 0 ? { sections: sectionLabels } : {}),
            ...(callEntries.length > 0 ? { calls: callEntries } : {}),
            ...(pollRecords.length > 0 ? { polls: pollRecords } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
              ? { world: worldReadsWrites }
              : {}),
            ...(declared ? { declared } : {}),
            ...(pageEvents ? { page_events: pageEvents } : {}),
            ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
            ...(httpLogFailed ? { http_log_failed: httpLogFailed } : {}),
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(truncated !== undefined ? { truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
            ...claimFields,
          }
        : {
            schema_version: SCHEMA_VERSIONS.step_record,
            nukadoko: readOwnVersion(),
            step_record_id: begun.recordId,
            step: outcomeStepName,
            kind: "run",
            args: recordedArgs,
            ...(argsOrigin !== undefined ? { args_origin: argsOrigin } : {}),
            // `errorKind` is guaranteed set by this point: the caller always
            // passes one alongside `initialStatus === "failed"`, and this
            // function no longer demotes a "passed" status to "failed" itself.
            // The `?? "step_error"`
            // fallback is a belt-and-braces default only, matching the
            // general principle of defaulting to step_error whenever
            // classification is uncertain — it should never actually be reached.
            error: { message: errorMessage, kind: errorKind ?? "step_error" },
            status: "failed",
            environment,
            world_name: programWorld?.name ?? null,
            target_version: targetVersion,
            scenario_record_id: scenarioId,
            run_id: runId,
            started_at: stepStartedAt.toISOString(),
            finished_at: stepFinishedAt.toISOString(),
            evidence: {
              dir: begun.relativeRecordDir,
              screenshots: [],
              ...(httpLogExists ? { http: "http.jsonl" } : {}),
              ...traceFileFields(traceEvidence),
              ...evidenceMetaFields(evidenceSnapshot),
            },
            observed,
            mutates,
            // Unstripped here, unlike the "passed" branch above: a failed
            // step's step record is exactly
            // where a reader most needs "what upstream value did this read",
            // without opening a second record.json to find out.
            ...(usedEntries.length > 0 ? { used: usedEntries } : {}),
            ...(sectionLabels.length > 0 ? { sections: sectionLabels } : {}),
            ...(callEntries.length > 0 ? { calls: callEntries } : {}),
            ...(pollRecords.length > 0 ? { polls: pollRecords } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
              ? { world: worldReadsWrites }
              : {}),
            ...(declared ? { declared } : {}),
            ...(pageEvents ? { page_events: pageEvents } : {}),
            ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
            ...(httpLogFailed ? { http_log_failed: httpLogFailed } : {}),
            ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
            ...(truncated !== undefined ? { truncated } : {}),
            ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
            ...claimFields,
          };

    // Redacted once, as one object, same as `nuka do`: record.json must
    // never be able to disagree with the
    // scenario record about what got redacted.
    const redactedStepRecord = redact(stepRecord, secrets) as StepRecord;
    await writeStepRecord(begun.recordDir, redactedStepRecord);

    if (status === "failed") {
      scenarioFailed = true;
    }
    const durationMs = stepFinishedAt.getTime() - stepStartedAt.getTime();
    pushStepRecord(
      {
        text: pickleStep.text,
        status,
        step_record_id: begun.recordId,
        ...(status === "failed" ? { error: { message: errorMessage } } : {}),
      },
      durationMs,
      redactedStepRecord,
    );
    // Returned so After and AfterStep report this same duration. Measuring
    // again after this function returns would include the time spent
    // writing the step record, which the hook did not run inside.
    return durationMs;
  }

  // --- Hooks + World ---
  // One World per pickle, shared by every compat step and hook that runs in
  // it, wrapping this same `contextHandle.ctx` a typed step's `run` also
  // receives ("1 pickle = 1 World = 1 ctx"). `worldInstrumentation`
  // is this same World's own measurement handle — advanced (`beginStep()`)
  // at the exact same points
  // `contextHandle.beginStep()` is called below, and read (`snapshot()`)
  // inside `finishExecutedStep` and this function's own backstop catch.
  // One collector for this whole
  // pickle. Repointed as "the currently active declared collector" (read by
  // the registered allure-js `TestRuntime`, src/compat/allure-runtime.ts) and
  // passed directly into `instantiateCompatWorld` so this pickle's own
  // `world.attach`/`log`/`link` write into the exact same instance (src/
  // compat/world.ts's own header explains why the World channel gets the
  // object passed directly rather than reading it back through the active
  // pointer) — a facade call and a World-channel call in the same step/hook
  // land in the same place either way. Its own `beginStep`/`snapshot` are
  // called at each step/hook boundary below, independently of
  // `contextHandle`/`worldInstrumentation`'s own boundary calls.
  const declaredCollector = createDeclaredCollector();
  setActiveDeclaredCollector(declaredCollector);
  // Construction sits outside every hook and step, and used to sit outside
  // every catch too. A throw then left this function, so the caller's loop
  // never reached the next scenario or the export finalization that follows
  // the loop. Fail this scenario instead, with one line, and return a record.
  let created: InstantiatedWorld;
  try {
    created = instantiateCompatWorld(contextHandle.ctx, declaredCollector, config.worldParameters);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const setupMessage = `World setup failed: ${detail}`;
    const fixtureTeardownErrors = await teardownFixtureCache(fixtureScenarioCache, "failed");
    try {
      // Nothing in this pickle opened a browser, but the context was still
      // created above. Dispose it here: returning without that leaks it,
      // and a dispose failure must not replace the record this catch writes.
      await contextHandle.dispose();
    } catch {
      // Same backstop as this function's normal end: teardown must not take
      // the scenario record down with it.
    }
    const failedSteps: ScenarioStepEntry[] = pickle.steps.map((pickleStep, index) => {
      if (index === 0) {
        return {
          text: pickleStep.text,
          status: "failed",
          step_record_id: null,
          error: { message: setupMessage },
        };
      }
      return { text: pickleStep.text, status: "skipped", step_record_id: null };
    });
    const setupFinishedAt = new Date();
    const setupRecord: ScenarioRecord = {
      nukadoko: readOwnVersion(),
      scenario_record_id: scenarioId,
      run_id: runId,
      feature: relativeFeaturePath,
      scenario: pickle.name,
      line: pickle.location?.line ?? 0,
      status: "failed",
      environment,
      ...(targetVersion !== undefined ? { target_version: targetVersion } : {}),
      started_at: startedAt.toISOString(),
      finished_at: setupFinishedAt.toISOString(),
      steps: failedSteps,
      hooks: [],
      ...(git !== undefined ? { git } : {}),
      evidence: { dir: relativeScenarioDir, screenshots: [] },
      ...(fixtureTeardownErrors.length > 0 ? { teardown_errors: fixtureTeardownErrors } : {}),
    };
    const redactedSetupRecord = redact(setupRecord, secrets) as ScenarioRecord;
    setActiveDeclaredCollector(undefined);
    onWorldSetupFailure?.(setupMessage);
    return redactedSetupRecord;
  }
  const { world, instrumentation: worldInstrumentation } = created;
  const pickleTags = pickle.tags.map((tag) => tag.name);
  const beforeHooks = compatHooks.filter(
    (hook) => hook.type === "before" && hookApplies(hook.tags, pickleTags),
  );
  // After hooks run in reverse registration order — cucumber-js's own
  // convention: teardown unwinds in the opposite order setup ran in.
  const afterHooks = compatHooks
    .filter((hook) => hook.type === "after" && hookApplies(hook.tags, pickleTags))
    .slice()
    .reverse();
  // AfterStep hooks: same
  // tag-filter as Before/After. Kept in registration order, unlike After's
  // own reversal above — that reversal exists because After is teardown for
  // Before's setup and cucumber-js unwinds teardown in the opposite order
  // setup ran in; AfterStep has no such setup/teardown pairing (each
  // AfterStep hook is independent of every other one), so there is no
  // "unwind" for a reversal to model.
  const afterStepHooks = compatHooks.filter(
    (hook) => hook.type === "after_step" && hookApplies(hook.tags, pickleTags),
  );

  // Hooks get their own boundary, never a step's own step record dir
  // (a hook's own network stays outside any step
  // boundary) — redirected to the scenario dir itself, the same place
  // `boundaryDir` already starts out pointed at before any step's own
  // `beginStep()` call ever runs. That boundary opens
  // once per *individual* hook invocation, inside the loop below, each with
  // its own title/chunk file (`hookChunkTitle`/`hookChunkFileName`) — the
  // same per-invocation granularity `declaredCollector.beginStep` already
  // had, now shared by the trace chunk
  // too, so a Before hook that touches `ctx.page()` gets a chunk isolated
  // from its sibling Before hooks and from every step's own chunk.
  for (const hook of beforeHooks) {
    const title = hookDisplayTitle("Before", hook.name);
    const chunkFileName = hookChunkFileName("before", hook.registrationOrder);
    await contextHandle.beginStep(scenarioDir, hookChunkTitle("before", hook.name), chunkFileName);
    // Same per-boundary point for the World's own instrumentation — a
    // Before hook's own World reads/writes get tallied here but are
    // discarded by the next `beginStep()` call (the next Before hook, or
    // step 1's own), so they are never attributed to any step's step record,
    // the same isolation `observed`/`used` already give hooks.
    worldInstrumentation.beginStep();
    // Each hook gets its own declared
    // boundary — reset right before it runs, read right after — so one
    // hook's own facade/World-channel calls land on exactly that hook's own
    // `hookRecords` entry, never smeared across its sibling Before hooks.
    declaredCollector.beginStep(scenarioDir);
    // `HookParameter.result` is absent for a Before hook (cucumber-js
    // never sets it there either — a scenario's outcome isn't known yet).
    const hookParameter = buildHookParameter(gherkinDocument, pickle, scenarioId, undefined);
    // The arity check and the
    // pending/skipped return are both classified `"unsupported"` directly,
    // at the exact point each is detected — set on `hookStatus`/
    // `hookErrorKind` rather than thrown, so they never need to be told
    // apart from a hook's own throw (`timeout`/`world_invalid`/`step_error`,
    // via `classifyCaughtError`) inside a shared catch block afterward. This
    // mirrors the compat step branch's own arity/pending-skipped checks
    // further down in this file, which already work the same non-throwing
    // way.
    let hookStatus: "passed" | "failed" = "passed";
    let hookErrorMessage = "";
    let hookErrorKind: ErrorKind = "step_error";
    let thrown: unknown;
    if (declaresDoneCallback(hook.fn.length, SCENARIO_HOOK_ARG_COUNT)) {
      // This arity check, before the call itself (see runWithTimeout's
      // own header for why calling it at all would already be the failure).
      hookStatus = "failed";
      hookErrorMessage = doneCallbackMessage("Hook", title);
      hookErrorKind = "unsupported";
    } else {
      try {
        const returnValue = await runWithTimeout(
          () => Promise.resolve(hook.fn.call(world, hookParameter)),
          hook.timeoutMs ?? defaultTimeoutMs,
          "Hook",
          title,
        );
        if (returnValue === "pending" || returnValue === "skipped") {
          hookStatus = "failed";
          hookErrorMessage = pendingOrSkippedMessage("Hook", title, returnValue);
          hookErrorKind = "unsupported";
        }
      } catch (error) {
        hookStatus = "failed";
        hookErrorMessage = error instanceof Error ? error.message : String(error);
        hookErrorKind = classifyCaughtError(error);
        thrown = error;
      }
    }
    // Closes this hook's own trace chunk, if one is open, *before* its own
    // `hookRecords` entry is built — the same
    // "close, then read" order `finishExecutedStep` already follows for a
    // step's own chunk, so `trace` is never set on a record whose chunk
    // hasn't actually finished writing yet.
    await contextHandle.endStep();
    const hookTraceEvidence = await collectTraceEvidence(scenarioDir, onUnknownTraceVersion, chunkFileName, contextHandle.namedContexts());
    const declared = declaredCollector.snapshot();
    if (hookStatus === "passed") {
      hookRecords.push({
        type: "before",
        status: "passed",
        ...recordedHookName(hook.name),
        ...traceFileFields(hookTraceEvidence),
        ...(hookTraceEvidence.actions !== undefined ? { actions: hookTraceEvidence.actions } : {}),
        ...(hookTraceEvidence.truncated !== undefined ? { truncated: hookTraceEvidence.truncated } : {}),
        ...(declared ? { declared } : {}),
      });
    } else {
      hookRecords.push({
        type: "before",
        status: "failed",
        error: { message: hookErrorMessage, kind: hookErrorKind },
        ...recordedHookName(hook.name),
        ...traceFileFields(hookTraceEvidence),
        ...(hookTraceEvidence.actions !== undefined ? { actions: hookTraceEvidence.actions } : {}),
        ...(hookTraceEvidence.truncated !== undefined ? { truncated: hookTraceEvidence.truncated } : {}),
        ...(declared ? { declared } : {}),
      });
      scenarioFailed = true;
      // The failure After will report. A Before failure skips every step,
      // so this is the only failure the scenario holds.
      noteFailure(hookErrorMessage, 0, thrown);
      // Stop at the first Before failure — a Before
      // failure skips every step: this scenario's setup already didn't
      // complete, so there is nothing left for a later Before hook to
      // prepare into.
      break;
    }
  }

  /**
   * Runs every applicable AfterStep hook for one pickle step that actually
   * executed — the three
   * call sites below are exactly the three places a step's own execution
   * reaches a final `"passed"`/`"failed"` status: the typed branch, the compat
   * branch, and the general per-step backstop catch's `began !== null` arm.
   * A step that never began at all (undefined, ambiguous, the read-only
   * declared-mutates refusal, or the backstop's own `began === null` arm)
   * has no step record and no "after" for this hook to run at, so none of those
   * call this function — the same reasoning already covers a step this
   * scenario skipped outright (the `if (scenarioFailed)` check at the very
   * top of the loop below never reaches this function either, since it
   * `continue`s before matching/running anything).
   *
   * `stepStatus` is that one step's own outcome, not the scenario's running
   * one (`HookParameter.result` reflects "the step itself", the
   * same distinction `buildHookParameter`'s own header draws for After).
   *
   * Failure handling mirrors the After loop above exactly (read
   * that loop before touching this one) — an AfterStep hook's own failure
   * still lets every other AfterStep hook for this same step run (no
   * `break`, unlike the Before loop above: Before breaks because its own
   * phase failing leaves nothing left to prepare into, but a sibling
   * AfterStep hook for this exact step is just as reachable as it always
   * was) and only sets `scenarioFailed` — which the next iteration of the
   * pickle.steps loop below reads, skipping every remaining step exactly as
   * if that step itself had failed.
   */
  async function runAfterStepHooks(
    stepIndex: number,
    step: {
      readonly pickleStep: PickleStep;
      readonly testStepId: string;
      readonly status: "passed" | "failed";
      readonly durationMs: number;
      readonly errorMessage: string;
      readonly thrown: unknown;
    },
  ): Promise<void> {
    // Noted even when no AfterStep hook is registered: After still has to
    // see this step's duration, and its message and thrown value if it
    // failed. The early return below used to skip the whole function.
    if (step.status === "passed") {
      passedDurationMs = step.durationMs;
    } else {
      noteFailure(step.errorMessage, step.durationMs, step.thrown);
    }
    if (afterStepHooks.length === 0) {
      return;
    }
    const hookParameter = buildHookParameter(
      gherkinDocument,
      pickle,
      scenarioId,
      step.status === "passed" ? "PASSED" : "FAILED",
      {
        includeError: true,
        durationMs: step.durationMs,
        message: step.status === "failed" ? step.errorMessage : undefined,
        error: step.status === "failed" ? step.thrown : undefined,
        pickleStep: step.pickleStep,
        testStepId: step.testStepId,
      },
    );
    for (const hook of afterStepHooks) {
      const title = hookDisplayTitle("AfterStep", hook.name);
      // Same boundary redirect as the Before/After loops (this file's own
      // header): a hook's own
      // network activity stays outside any step's own step record boundary.
      // Without this, an AfterStep hook's own requests would keep writing
      // into the step it just ran after's own http.jsonl, even though that
      // step's step record (and its `observed` tally) was already built and
      // written by `finishExecutedStep` before this function is ever
      // called. `stepIndex` is folded into both the title and the chunk
      // file name — this same hook can run again
      // after a *later* step in this same scenario, and each of those
      // invocations needs its own chunk, never overwriting the previous
      // one's.
      const chunkFileName = hookChunkFileName("after_step", hook.registrationOrder, stepIndex);
      await contextHandle.beginStep(scenarioDir, hookChunkTitle("after_step", hook.name, stepIndex), chunkFileName);
      worldInstrumentation.beginStep();
      // Same per-hook declared boundary as the Before/After loops —
      // reset right before, read right
      // after, so one AfterStep hook's own declared data never bleeds into a
      // sibling's.
      declaredCollector.beginStep(scenarioDir);
      let hookStatus: "passed" | "failed" = "passed";
      let hookErrorMessage = "";
      let hookErrorKind: ErrorKind = "step_error";
      let thrown: unknown;
      if (declaresDoneCallback(hook.fn.length, SCENARIO_HOOK_ARG_COUNT)) {
        hookStatus = "failed";
        hookErrorMessage = doneCallbackMessage("Hook", title);
        hookErrorKind = "unsupported";
      } else {
        try {
          const returnValue = await runWithTimeout(
            () => Promise.resolve(hook.fn.call(world, hookParameter)),
            hook.timeoutMs ?? defaultTimeoutMs,
            "Hook",
            title,
          );
          if (returnValue === "pending" || returnValue === "skipped") {
            hookStatus = "failed";
            hookErrorMessage = pendingOrSkippedMessage("Hook", title, returnValue);
            hookErrorKind = "unsupported";
          }
        } catch (error) {
          hookStatus = "failed";
          hookErrorMessage = error instanceof Error ? error.message : String(error);
          hookErrorKind = classifyCaughtError(error);
          thrown = error;
        }
      }
      // Same "close, then read" order as the Before loop above.
      await contextHandle.endStep();
      const hookTraceEvidence = await collectTraceEvidence(scenarioDir, onUnknownTraceVersion, chunkFileName, contextHandle.namedContexts());
      const declared = declaredCollector.snapshot();
      if (hookStatus === "passed") {
        hookRecords.push({
          type: "after_step",
          step_index: stepIndex,
          status: "passed",
          ...recordedHookName(hook.name),
          ...traceFileFields(hookTraceEvidence),
          ...(hookTraceEvidence.actions !== undefined ? { actions: hookTraceEvidence.actions } : {}),
          ...(hookTraceEvidence.truncated !== undefined ? { truncated: hookTraceEvidence.truncated } : {}),
          ...(declared ? { declared } : {}),
        });
      } else {
        hookRecords.push({
          type: "after_step",
          step_index: stepIndex,
          status: "failed",
          error: { message: hookErrorMessage, kind: hookErrorKind },
          ...recordedHookName(hook.name),
          ...traceFileFields(hookTraceEvidence),
          ...(hookTraceEvidence.actions !== undefined ? { actions: hookTraceEvidence.actions } : {}),
          ...(hookTraceEvidence.truncated !== undefined ? { truncated: hookTraceEvidence.truncated } : {}),
          ...(declared ? { declared } : {}),
        });
        // No `break` — see this function's own header (same
        // non-breaking failure handling as the After loop above).
        scenarioFailed = true;
        // A step that already failed keeps its own message. A passing
        // step whose AfterStep hook fails is the failure After reports.
        noteFailure(hookErrorMessage, 0, thrown);
      }
    }
  }

  for (const [stepIndex, pickleStep] of pickle.steps.entries()) {
    if (scenarioFailed) {
      // A step skipped because an earlier
      // one already failed never executes, so it never reaches any of the
      // three `runAfterStepHooks` call sites below either — this `continue`
      // is exactly where that "no after for a skipped step" boundary lives.
      pushStepRecord({ text: pickleStep.text, status: "skipped", step_record_id: null }, 0);
      continue;
    }

    // General per-step backstop: everything from matching this step's text
    // through
    // writing its step record sits inside the try below, so ANY unexpected
    // throw still leaves this pickle's own scenario record written
    // (docs/spec.md "Running": once a pickle begins executing, every step
    // gets a record entry) instead of crashing the whole `nuka run`
    // invocation uncaught. The violation this backstop exists for: a
    // custom `config.parameterTypes` transformer's throw propagates
    // unchanged straight out of match-step.ts's `matchPickleStep` (that
    // file's own header comment — cucumber-expressions itself
    // never catches a transformer call, and that module deliberately
    // doesn't either), and nothing between it and here used to catch it.
    // This backstop changes nothing about any failure already
    // handled by name below (undefined/ambiguous/binding failure/args
    // zod/the step's own `run` throw/the read-only declared-mutates
    // refusal) — each keeps its own branch, unchanged; this is only the
    // last net underneath all of them. `began` mirrors the exact point
    // (marked below) this function already
    // treats as "a step record is always written from here on": a throw
    // before it is "never began" (`step_record_id: null`, the same family as
    // undefined/ambiguous/the read-only declared-mutates refusal just
    // below), while a throw at or after it still gets a step record
    // written, exactly like any other execution-phase failure this
    // function already handles inline.
    //
    // This iteration's own start, read by the
    // `began === null` arm of the backstop catch below — the one step
    // outcome with no more precise start time available (nothing "began"
    // yet in the sense above), so its own progress line reports elapsed
    // time since matching this step started rather than since some step
    // record that was never opened.
    const stepLoopStartedAt = new Date();
    let began: {
      readonly recordId: string;
      readonly recordDir: string;
      readonly relativeRecordDir: string;
      readonly stepName: string;
      readonly startedAt: Date;
      // This step's own declared `mutates` (typed) or `null` (compat) —
      // carried on `began` so the general backstop catch below (which has
      // no `entry` in scope of its own) can still put the right value on a
      // step record it has to write.
      readonly mutates: boolean | null;
      rawArgs: unknown;
      // Names where a key of `rawArgs` came from, for the backstop's step
      // record; `undefined` for a compat step.
      originOf: ((key: string) => ArgOrigin | undefined) | undefined;
    } | null = null;
    // Every `config.fixtures` entry this step's own bag actually resolved —
    // hoisted to this scope, alongside
    // `began`, so the general backstop catch below can still put it on the
    // step record it writes for an unexpected throw that happens *after*
    // fixture resolution succeeded but before `finishExecutedStep` runs.
    // `[]` (hence omitted on the step record) for a compat step, or a typed
    // step whose own fixture resolution never ran at all (undefined/
    // ambiguous/binding failure/args validation failure).
    let fixtureUsage: FixtureUsageEntry[] = [];

    try {
      const outcome = await matchPickleStep(pickleStep.text, bindings, world);

      if (outcome.kind === "undefined") {
        scenarioFailed = true;
        const message = undefinedStepMessage(pickleStep.text);
        noteFailure(message, 0, undefined);
        pushStepRecord(
          {
            text: pickleStep.text,
            status: "undefined",
            step_record_id: null,
            error: { message },
          },
          0,
        );
        continue;
      }

      if (outcome.kind === "ambiguous") {
        scenarioFailed = true;
        const message = ambiguousStepMessage(pickleStep.text, outcome.stepNames);
        noteFailure(message, 0, undefined);
        pushStepRecord(
          {
            text: pickleStep.text,
            status: "ambiguous",
            step_record_id: null,
            error: { message },
          },
          0,
        );
        continue;
      }

      const entry = vocabulary.get(outcome.stepName);
      if (!entry) {
        // Unreachable: `outcome.stepName` only ever comes from a binding built
        // from this same vocabulary (match-step.ts's buildStepBindings).
        continue;
      }

      if (entry.kind === "typed") {
        // Read-only policy, declared-mutates refusal: a "never began"
        // outcome, alongside undefined/
        // ambiguous above — no step record id or directory is created, and
        // the rest of the scenario is skipped, matching cli/do.ts's own
        // setup-phase refusal for the same policy. `mutates: false` steps
        // are unaffected regardless of policy — and so is a step that goes
        // on to actually write
        // despite that declaration: the declaration is trusted, not
        // re-verified against what execution measures, so
        // `finishExecutedStep` no longer has a backstop for it. A compat
        // entry has no declared `mutates` at all, so this check simply
        // does not apply to one; nothing
        // in this file checks a compat step's read-only behavior either.
        if (policy === "read-only" && entry.step.mutates) {
          scenarioFailed = true;
          const message = new ReadOnlyEnvironmentError(outcome.stepName, environment).message;
          noteFailure(message, 0, undefined);
          pushStepRecord(
            {
              text: pickleStep.text,
              status: "failed",
              step_record_id: null,
              error: { message },
            },
            0,
          );
          continue;
        }

        // --- This step's execution has begun: a step record is always
        // written from here, whatever happens (mirrors cli/do.ts's own
        // execution phase). ---
        const { id: recordId, dir: recordDir } = await createRecordDir(
          path.join(rootDir, runRelativeDir(config.stateDir, runId), RUN_FILE_DIRS.steps),
          generateStepRecordId,
        );
        const relativeRecordDir = stepRecordRelativeDir(config.stateDir, runId, recordId);
        // Titled with this step's own gherkin text, keyword included (this
        // file's own header) — the trace chunk `ctx.page()` opens lazily
        // during this step, if it does, self-identifies the same way.
        await contextHandle.beginStep(recordDir, stepChunkTitle(stepKeywords, pickleStep));
        worldInstrumentation.beginStep();
        declaredCollector.beginStep(recordDir);
        began = {
          recordId,
          recordDir,
          relativeRecordDir,
          stepName: outcome.stepName,
          startedAt: new Date(),
          mutates: entry.step.mutates,
          rawArgs: undefined,
          originOf: undefined,
        };
        const producedAt = lineOfStep(stepIndex);
        if (producedAt !== null) recordLines.set(recordId, producedAt);

        const bindResult = bindStepArgs(
          outcome.stepName,
          outcome.captures,
          outcome.values,
          pickleStep.argument,
          entry.step.args,
          new Set(Object.keys(entry.step.from)),
        );
        // The key a table or docstring filled, read before `from` adds
        // its keys to the same object: the one bound key no capture names.
        const captureKeys = new Set(outcome.captures.map((capture) => capture.key));
        const attachmentKey =
          bindResult.ok && pickleStep.argument !== undefined && bindResult.value !== null && typeof bindResult.value === "object"
            ? (Object.keys(bindResult.value).find((key) => !captureKeys.has(key)) ?? null)
            : null;
        const attachmentOrigin: ArgOrigin | undefined =
          pickleStep.argument?.docString !== undefined ? "docstring" : pickleStep.argument?.dataTable !== undefined ? "table" : undefined;
        const fromOrigins = new Map<string, ArgOrigin>();
        const originOf = (key: string): ArgOrigin | undefined =>
          captureKeys.has(key) ? "capture" : key === attachmentKey ? attachmentOrigin : fromOrigins.get(key);
        began.originOf = originOf;

        const stepStartedAt = new Date();
        let status: "passed" | "failed";
        let result: unknown;
        let errorMessage = "";
        let errorKind: ErrorKind | undefined;
        let thrown: unknown;
        let claimExecution: ClaimExecution | undefined;
        const rawArgs: unknown = bindResult.ok ? bindResult.value : bindResult.partialValue;
        began.rawArgs = rawArgs;
        // Defaults to the same raw/merged value as `began.rawArgs`;
        // overwritten with the schema-validated value below when args
        // validation succeeds, so this step's own step record shows what
        // `run` actually received (this function's own `finishExecutedStep`
        // parameter doc comment).
        let recordedArgs: unknown = rawArgs;

        if (!bindResult.ok) {
          status = "failed";
          errorMessage = bindResult.message;
          errorKind = "binding_invalid";
        } else {
          // `from` injection — after binding, so
          // capture already won every key it could; before args validation,
          // so an injected key is validated exactly like a captured one and
          // a required key `from` couldn't fill still fails args validation
          // normally (the "last line of defense" — the pre-execution
          // from-order guard above is what turns this into a fatal
          // check *before* the browser session even starts).
          const stillMissingFrom = injectFrom(
            bindResult.value,
            entry.step,
            chain,
            stepNameOf,
            contextHandle.recordUsed,
            (key, from) => fromOrigins.set(key, { from }),
          );
          // Before the schema runs: what a claim judges is the value the
          // line or the earlier step gave, never what the schema made of it.
          const claimArgs = snapshotClaimArgs(entry.step, bindResult.value);
          const argsResult = strictArgsSchema(entry.step.args).safeParse(bindResult.value);
          if (!argsResult.success) {
            status = "failed";
            errorMessage =
              `args validation failed: ${formatValidationIssues(argsResult.error.issues)}` +
              fromInjectionHint(argsResult.error.issues, stillMissingFrom);
            errorKind = "args_invalid";
          } else {
            recordedArgs = argsResult.data;
            // Fixture resolution, the step's own body or its claims, and the
            // deadline all run in execute-typed-step.ts, the one place
            // `nuka do` runs a step through too, so a claim is judged the
            // same way on both paths. A launch failure, a fixture setup
            // failure, or a fixture use()-contract violation fails the step
            // the same way the step's own throw does. `stepFixtureNames`
            // closes the names over `parts` (docs/spec.md "Parts"), so a part
            // that reaches for `page` gets the browser open before `run()`
            // starts.
            const executed = await runValidatedStep({
              name: outcome.stepName,
              step: entry.step,
              args: argsResult.data,
              ...(claimArgs === undefined ? {} : { claimArgs }),
              handle: contextHandle,
              fixtureGraph,
              scenarioCache: fixtureScenarioCache,
              processCache: fixtureProcessCache,
              config,
              argSide: (key) => claimArgSide(key, originOf(key), (id) => recordLines.get(id) ?? null),
              sentenceText: sentenceTextOf(
                outcome.captures,
                outcome.texts,
                attachmentKey === null
                  ? null
                  : {
                      key: attachmentKey,
                      ...(pickleStep.argument?.docString === undefined ? {} : { docString: pickleStep.argument.docString.content }),
                      ...(pickleStep.argument?.dataTable === undefined
                        ? {}
                        : { table: pickleStep.argument.dataTable.rows.map((row) => row.cells.map((cell) => cell.value)) }),
                    },
              ),
            });
            fixtureUsage = executed.fixtureUsage;
            claimExecution = executed.claims;
            if (executed.status === "passed") {
              status = "passed";
              result = executed.result;
            } else {
              status = "failed";
              errorMessage = executed.error.message;
              errorKind = executed.error.kind;
              thrown = executed.thrown;
            }
          }
        }

        const durationMs = await finishExecutedStep(
          pickleStep,
          { recordId, recordDir, relativeRecordDir },
          stepStartedAt,
          outcome.stepName,
          status,
          errorMessage,
          errorKind,
          result,
          recordedArgs,
          argOrigins(recordedArgs, originOf),
          entry.step,
          entry.step.mutates,
          fixtureUsage,
          claimExecution,
        );
        await runAfterStepHooks(stepIndex, {
          pickleStep,
          testStepId: recordId,
          status,
          durationMs,
          errorMessage,
          thrown,
        });
      } else {
        // entry.kind === "compat": fn is called with `this = World` and
        // positional arguments —
        // no args/returns schema exists to validate against, so there is no
        // binding-failure branch here the way there is for a typed step.
        const { id: recordId, dir: recordDir } = await createRecordDir(
          path.join(rootDir, runRelativeDir(config.stateDir, runId), RUN_FILE_DIRS.steps),
          generateStepRecordId,
        );
        const relativeRecordDir = stepRecordRelativeDir(config.stateDir, runId, recordId);
        // Titled with this step's own gherkin text, keyword included (this
        // file's own header) — same as the typed branch above.
        await contextHandle.beginStep(recordDir, stepChunkTitle(stepKeywords, pickleStep));
        worldInstrumentation.beginStep();
        declaredCollector.beginStep(recordDir);
        began = {
          recordId,
          recordDir,
          relativeRecordDir,
          stepName: outcome.stepName,
          startedAt: new Date(),
          // Compat has no `mutates` declaration at all — `null`, never
          // coerced to `false`.
          mutates: null,
          rawArgs: undefined,
          originOf: undefined,
        };

        // Positional args: the matched values, then — when the pickle step
        // carries a table or docstring — one more argument. The step
        // record's own `args` stays JSON-plain
        // (`string[][]`/`string`); the *function call* gets a richer
        // `DataTable` wrapping those same rows (a raw `string[][]` would
        // break existing glue calling
        // `table.hashes()`/`.rowsHash()`, which the migration-door rule
        // forbids) — two shapes for two different consumers of the exact
        // same data; the DataTable object itself is never what gets
        // serialized.
        const positionalArgs: unknown[] = [...outcome.values];
        const rawArgsList: unknown[] = [...outcome.values];
        if (pickleStep.argument?.dataTable !== undefined) {
          const rows = pickleStep.argument.dataTable.rows.map((row) =>
            row.cells.map((cell) => cell.value),
          );
          positionalArgs.push(new DataTable(rows));
          rawArgsList.push(rows);
        } else if (pickleStep.argument?.docString !== undefined) {
          positionalArgs.push(pickleStep.argument.docString.content);
          rawArgsList.push(pickleStep.argument.docString.content);
        }
        began.rawArgs = rawArgsList;

        const stepStartedAt = new Date();
        let status: "passed" | "failed" = "passed";
        let errorMessage = "";
        let errorKind: ErrorKind | undefined;
        let thrown: unknown;
        // This arity check, before the call itself: a compat step's
        // glue function declaring more parameters than `positionalArgs`
        // actually supplies is cucumber-js's own signal for a `done`
        // callback — nukadoko never passes one (see `doneCallbackMessage`'s
        // own header for why calling it anyway would already be the
        // failure this closes).
        if (declaresDoneCallback(entry.compat.fn.length, positionalArgs.length)) {
          status = "failed";
          errorMessage = doneCallbackMessage("Step", outcome.stepName);
          errorKind = "unsupported";
        } else {
          try {
            // `entry.compat.timeoutMs` is this step's own
            // `{ timeout }` (wired through discover-steps.ts's
            // `CompatStepDefinition.timeoutMs`) — `undefined` runs
            // unbounded. `?? defaultTimeoutMs` only ever takes effect when
            // this step declared no `{ timeout }` of its own.
            const returnValue = await runWithTimeout(
              () => contextHandle.recordingProcesses(() => Promise.resolve(entry.compat.fn.apply(world, positionalArgs))),
              entry.compat.timeoutMs ?? defaultTimeoutMs,
              "Step",
              outcome.stepName,
            );
            // cucumber-js's own pending/skipped return convention —
            // nukadoko doesn't implement either, so this fails loudly
            // instead of quietly passing (see `pendingOrSkippedMessage`'s
            // own header).
            if (returnValue === "pending" || returnValue === "skipped") {
              status = "failed";
              errorMessage = pendingOrSkippedMessage("Step", outcome.stepName, returnValue);
              errorKind = "unsupported";
            }
          } catch (error) {
            // Identified by
            // type (`CompatTimeoutError`/`WorldWriteValidationError`), never
            // by matching `message` — see `classifyCaughtError`'s own header.
            status = "failed";
            errorMessage = error instanceof Error ? error.message : String(error);
            errorKind = classifyCaughtError(error);
            thrown = error;
          }
        }

        // `result: null` unconditionally on a non-throwing run (docs/
        // spec.md "Records": "Compat steps record result: null") — never
        // whatever `fn` itself happened to return, and no `chain` entry
        // (compat has no validated result to make citable via
        // `ctx.resultOf`, and no Step object to key one on).
        const durationMs = await finishExecutedStep(
          pickleStep,
          { recordId, recordDir, relativeRecordDir },
          stepStartedAt,
          outcome.stepName,
          status,
          errorMessage,
          errorKind,
          null,
          rawArgsList,
          undefined,
          undefined,
          null,
          [],
        );
        await runAfterStepHooks(stepIndex, {
          pickleStep,
          testStepId: recordId,
          status,
          durationMs,
          errorMessage,
          thrown,
        });
      }
    } catch (error) {
      // The backstop itself (see the comment above `began`): anything that
      // threw without ever being turned into a `status`/`errorMessage` pair
      // above lands here. `began` says whether this step's own step record
      // phase had started by then, so the same "never began" vs "always
      // gets a step record" boundary this function already draws elsewhere
      // still holds.
      scenarioFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      if (began === null) {
        const durationMs = Date.now() - stepLoopStartedAt.getTime();
        noteFailure(message, durationMs, error);
        pushStepRecord(
          {
            text: pickleStep.text,
            status: "failed",
            step_record_id: null,
            error: { message },
          },
          durationMs,
        );
      } else {
        // Same "close this step's own chunk before reading anything from
        // its step record dir" call `finishExecutedStep` makes (this
        // file's own
        // header) — a chunk can be open here
        // too: `began !== null` means this step's own `beginStep` already
        // ran, so `ctx.page()` could already have opened one before the
        // uncaught throw this backstop exists for.
        // Before the chunk closes and before http.jsonl is looked for: the
        // flush can still append request lines (`finishExecutedStep`).
        const observed = await contextHandle.observedSnapshot();
        afterStepEnd.set(began.recordId, contextHandle.afterStepEnd());
        await contextHandle.endStep();
        const traceEvidence = await collectTraceEvidence(began.recordDir, onUnknownTraceVersion, "trace.zip", contextHandle.namedContexts());
        const stepFinishedAt = new Date();
        const httpLogExists = existsSync(path.join(began.recordDir, "http.jsonl"));
        const usedEntries = contextHandle.usedSnapshot();
        // Same backstop-only read as `observed`/`used` just above —
        // whatever labels this step
        // reached before the uncaught throw still belong on its step record.
        const sectionLabels = contextHandle.sectionsSnapshot();
        // Same backstop-only read again, for `calls` — a part this step
        // already called (successfully or not) before the uncaught throw
        // still belongs on its step record.
        const callEntries = contextHandle.callsSnapshot();
        // Same backstop-only read again, for `polls` — a poll this step
        // was mid-wait on when the uncaught throw
        // hit still finished (`finally` in poll.ts's own loop guarantees
        // that), so its own record still belongs on this step record.
        const pollRecords = contextHandle.pollsSnapshot();
        // Same backstop-only read again, for `required_env` — whatever
        // names this step
        // required before the uncaught throw still belong on its step record.
        const requiredEnv = contextHandle.envReadsSnapshot();
        // Same backstop-only read again, for `page_events` — whatever the
        // browser context already saw before the
        // uncaught throw still belongs on this step record.
        const pageEvents = contextHandle.pageEventsSnapshot();
        // Same backstop-only read again, for `http_omitted` — whatever the
        // page already left
        // out of http.jsonl before the uncaught throw still belongs on this
        // step record.
        const httpOmitted = contextHandle.httpOmittedSnapshot();
        const httpLogFailed = contextHandle.httpLogFailedSnapshot();
        const worldReadsWrites = worldInstrumentation.snapshot();
        const declared = declaredCollector.snapshot();
        // Same backstop-only read again, for `evidence.attach`/`.path` —
        // whatever this step already wrote before the
        // uncaught throw still belongs on its step record.
        const evidenceSnapshot = await contextHandle.evidenceSnapshot();
        const truncated = mergeTruncated(traceEvidence.truncated, evidenceSnapshot.truncatedCount);
        const stepRecord: StepRecord = {
          schema_version: SCHEMA_VERSIONS.step_record,
          nukadoko: readOwnVersion(),
          step_record_id: began.recordId,
          step: began.stepName,
          kind: "run",
          args: began.rawArgs,
          ...(began.originOf !== undefined ? optionalArgsOrigin(argOrigins(began.rawArgs, began.originOf)) : {}),
          // This is the true catch-all: whatever threw here was never
          // turned into an `ErrorKind` by any of the classification points
          // above, so this is the default-to-step_error-when-uncertain case
          // itself, not just its fallback.
          error: { message, kind: "step_error" },
          status: "failed",
          environment,
          world_name: programWorld?.name ?? null,
          target_version: targetVersion,
          scenario_record_id: scenarioId,
          run_id: runId,
          started_at: began.startedAt.toISOString(),
          finished_at: stepFinishedAt.toISOString(),
          evidence: {
            dir: began.relativeRecordDir,
            screenshots: [],
            ...(httpLogExists ? { http: "http.jsonl" } : {}),
            ...traceFileFields(traceEvidence),
            ...evidenceMetaFields(evidenceSnapshot),
          },
          observed,
          mutates: began.mutates,
          ...(usedEntries.length > 0 ? { used: usedEntries } : {}),
          ...(sectionLabels.length > 0 ? { sections: sectionLabels } : {}),
          ...(callEntries.length > 0 ? { calls: callEntries } : {}),
          ...(pollRecords.length > 0 ? { polls: pollRecords } : {}),
          ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
          ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
            ? { world: worldReadsWrites }
            : {}),
          ...(declared ? { declared } : {}),
          ...(pageEvents ? { page_events: pageEvents } : {}),
          ...(httpOmitted ? { http_omitted: httpOmitted } : {}),
          ...(httpLogFailed ? { http_log_failed: httpLogFailed } : {}),
          ...(traceEvidence.actions !== undefined ? { actions: traceEvidence.actions } : {}),
          ...(truncated !== undefined ? { truncated } : {}),
          // `fixtureUsage` (hoisted above, alongside `began`): whatever this
          // step's own bag had already resolved before the uncaught throw
          // this backstop exists for still belongs on its step record.
          ...(fixtureUsage.length > 0 ? { fixtures: fixtureUsage } : {}),
        };
        const redactedStepRecord = redact(stepRecord, secrets) as StepRecord;
        await writeStepRecord(began.recordDir, redactedStepRecord);
        const durationMs = stepFinishedAt.getTime() - began.startedAt.getTime();
        pushStepRecord(
          {
            text: pickleStep.text,
            status: "failed",
            step_record_id: began.recordId,
            error: { message },
          },
          durationMs,
          redactedStepRecord,
        );
        // `began !== null`: this step's own execution had already begun (a
        // step record was written above) before the uncaught throw this
        // backstop exists for — so, unlike the `began === null` arm just above (never
        // began at all), this step did execute, and AfterStep runs after it
        // exactly like the typed/compat branches' own calls further up.
        await runAfterStepHooks(stepIndex, {
          pickleStep,
          testStepId: began.recordId,
          status: "failed",
          durationMs,
          errorMessage: message,
          thrown: error,
        });
      }
    }
  }

  // After hooks are attempted regardless of Before/step outcome, before
  // dispose() so a hook can still use
  // `this.page`/`this.request` while the browser/request context is open —
  // redirected to the scenario's own boundary for the same reason Before
  // hooks are, above, rather than left pointed at whichever step happened
  // to run last. Each individual After hook opens its
  // own boundary (title + chunk file), inside the loop below, the same
  // per-invocation shape the Before loop above now has.
  for (const hook of afterHooks) {
    const title = hookDisplayTitle("After", hook.name);
    const chunkFileName = hookChunkFileName("after", hook.registrationOrder);
    await contextHandle.beginStep(scenarioDir, hookChunkTitle("after", hook.name), chunkFileName);
    worldInstrumentation.beginStep();
    // Same per-hook declared boundary as the Before loop above — reset
    // right before, read right after, so one After
    // hook's own declared data never bleeds into a sibling's.
    declaredCollector.beginStep(scenarioDir);
    // `result.status` reflects the scenario's outcome *as of right
    // before this After hook runs* — every Before hook and every step has
    // already had its chance to set `scenarioFailed`, and an earlier After
    // hook in this same loop (if any) already folded its own failure in too
    // (cucumber-js's own convention: each After hook sees the running
    // outcome, not only the pre-teardown one).
    const hookParameter = buildHookParameter(
      gherkinDocument,
      pickle,
      scenarioId,
      scenarioFailed ? "FAILED" : "PASSED",
      {
        includeError: true,
        durationMs: scenarioFailed ? (heldFailure?.durationMs ?? 0) : passedDurationMs,
        message: scenarioFailed ? heldFailure?.message : undefined,
        error: scenarioFailed ? heldFailure?.error : undefined,
      },
    );
    // Same non-throwing arity/pending-skipped classification as the Before
    // loop above — see that loop's own
    // comment for why.
    let hookStatus: "passed" | "failed" = "passed";
    let hookErrorMessage = "";
    let hookErrorKind: ErrorKind = "step_error";
    let thrown: unknown;
    if (declaresDoneCallback(hook.fn.length, SCENARIO_HOOK_ARG_COUNT)) {
      hookStatus = "failed";
      hookErrorMessage = doneCallbackMessage("Hook", title);
      hookErrorKind = "unsupported";
    } else {
      try {
        const returnValue = await runWithTimeout(
          () => Promise.resolve(hook.fn.call(world, hookParameter)),
          hook.timeoutMs ?? defaultTimeoutMs,
          "Hook",
          title,
        );
        if (returnValue === "pending" || returnValue === "skipped") {
          hookStatus = "failed";
          hookErrorMessage = pendingOrSkippedMessage("Hook", title, returnValue);
          hookErrorKind = "unsupported";
        }
      } catch (error) {
        hookStatus = "failed";
        hookErrorMessage = error instanceof Error ? error.message : String(error);
        hookErrorKind = classifyCaughtError(error);
        thrown = error;
      }
    }
    // Same "close, then read" order as the Before loop above — this hook's
    // own chunk (if any) is written to
    // disk, and read back, *before* `dispose()` closes the browser context
    // for good just below this loop.
    await contextHandle.endStep();
    const hookTraceEvidence = await collectTraceEvidence(scenarioDir, onUnknownTraceVersion, chunkFileName, contextHandle.namedContexts());
    const declared = declaredCollector.snapshot();
    if (hookStatus === "passed") {
      hookRecords.push({
        type: "after",
        status: "passed",
        ...recordedHookName(hook.name),
        ...traceFileFields(hookTraceEvidence),
        ...(hookTraceEvidence.actions !== undefined ? { actions: hookTraceEvidence.actions } : {}),
        ...(hookTraceEvidence.truncated !== undefined ? { truncated: hookTraceEvidence.truncated } : {}),
        ...(declared ? { declared } : {}),
      });
    } else {
      hookRecords.push({
        type: "after",
        status: "failed",
        error: { message: hookErrorMessage, kind: hookErrorKind },
        ...recordedHookName(hook.name),
        ...traceFileFields(hookTraceEvidence),
        ...(hookTraceEvidence.actions !== undefined ? { actions: hookTraceEvidence.actions } : {}),
        ...(hookTraceEvidence.truncated !== undefined ? { truncated: hookTraceEvidence.truncated } : {}),
        ...(declared ? { declared } : {}),
      });
      scenarioFailed = true;
      // The next After hook sees this failure when nothing earlier already
      // failed the scenario. A step failure already held stays the one
      // reported: noteFailure keeps the first.
      noteFailure(hookErrorMessage, 0, thrown);
    }
  }

  const finishedAt = new Date();

  // Every step and hook has had its chance to set `scenarioFailed`.
  // Set before the await so a signal delivered on the next turn sees the
  // settled outcome rather than the provisional `"failed"`.
  scenarioOutcome = scenarioFailed ? "failed" : "passed";
  await tearDownScenario();
  const { evidence: browserEvidence, browser: browserInfo } = disposeResult;

  const record: ScenarioRecord = {
    nukadoko: readOwnVersion(),
    scenario_record_id: scenarioId,
    run_id: runId,
    feature: relativeFeaturePath,
    scenario: pickle.name,
    line: pickle.location?.line ?? 0,
    status: scenarioFailed ? "failed" : "passed",
    environment,
    ...(targetVersion !== undefined ? { target_version: targetVersion } : {}),
    // Measured, not declared (src/record/scenario-record.ts's `browser`
    // field). Absent whenever this scenario's own run never launched a
    // browser at all.
    ...(browserInfo !== undefined ? { browser: browserInfo } : {}),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    steps: stepRecords.map((entry) => {
      const late = entry.step_record_id === null ? undefined : afterStepEnd.get(entry.step_record_id);
      return late === undefined || (late.requests === 0 && late.processes === 0)
        ? entry
        : {
            ...entry,
            after_step_end: { requests: late.requests, processes: late.processes, ...(late.requests > 0 ? { http: "http.jsonl" as const } : {}) },
          };
    }),
    hooks: hookRecords,
    ...(git !== undefined ? { git } : {}),
    evidence: {
      dir: relativeScenarioDir,
      screenshots: browserEvidence.screenshots,
    },
    ...(fixtureTeardownErrors.length > 0 ? { teardown_errors: fixtureTeardownErrors } : {}),
  };

  const redactedRecord = redact(record, secrets) as ScenarioRecord;
  // This pickle is done — repoint "the currently active declared collector"
  // to nothing, so a stray facade call between this pickle and the next
  // (there shouldn't be one, but this mirrors `used`/`observed`'s own "never
  // let a boundary bleed into unrelated code" discipline) can't silently
  // land on an already-read collector instead of being dropped.
  setActiveDeclaredCollector(undefined);
  // This scenario's context is already disposed. Leave the signal handler
  // pointing at nothing so a later signal does not dispose it again.
  processSignal?.setScenarioCleanup(null);
  return redactedRecord;
}
