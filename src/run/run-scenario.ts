import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type GherkinDocument, type Pickle, type PickleStep } from "@cucumber/messages";
import type { z } from "zod";
import { formatValidationIssues } from "../binding/format-issues.js";
import type { CheckedPattern } from "../check/binding-check.js";
import { checkFromOrder } from "../check/from-order.js";
import { checkUnfillableKeys } from "../check/unfillable-key.js";
import { DataTable } from "../compat/data-table.js";
import {
  createDeclaredCollector,
  setActiveDeclaredCollector,
  type DeclaredCollector,
} from "../compat/declared.js";
import { CompatTimeoutError, isWorldWriteValidationError } from "../compat/errors.js";
import type { HookParameter, HookRegistration } from "../compat/hooks.js";
import { hookApplies } from "../compat/tag-expression.js";
import type { InstantiatedWorld } from "../compat/world.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContext } from "../context.js";
import { createStepContext } from "../context/create-context.js";
import { omitUsedResults } from "../context/used.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { generateReceiptId } from "../receipt/receipt-id.js";
import type { ErrorKind, Receipt } from "../receipt/types.js";
import { writeReceipt } from "../receipt/write-receipt.js";
import { redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { writeSessionFile } from "../session/store.js";
import type { StorageState } from "../session/storage-state.js";
import { fromCandidates, type Step } from "../step/define-step.js";
import { bindStepArgs, matchPickleStep, type StepBinding } from "./match-step.js";
import type { GitState } from "./probe-git.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "./record-types.js";
import { generateScenarioId } from "./scenario-id.js";
import { writeScenarioRecord } from "./write-record.js";

// Responsibility: execute one pickle end to end (this task's spec, item 1's
// own name for this: a scenario executor) — the scenario-level counterpart to cli/do.ts's execution
// phase. One `ctx` is created for the whole pickle and shared by every step
// (docs/spec.md "Running": "Steps in one pickle share one context"); a
// step's own failure/undefined/ambiguous stops matching or running any
// further step in this scenario, but every step still gets a scenario-record
// entry (`skipped` for the rest). Evidence follows its natural scope (this
// task's spec, decision 5): the browser's
// trace/screenshots belong to the scenario as a whole (one `dispose()` call,
// at the very end), while each step's own http.jsonl belongs to that step's
// receipt dir — reached by calling `contextHandle.beginStep` right before
// running each step that begins execution.
//
// The two "never began" outcomes (undefined, ambiguous) are resolved
// *before* a receipt id or directory is created — matching docs/spec.md "an
// execution that never began must not be citable". Every other failure
// (binding, args validation, the step's own throw, returns validation)
// happens *after* that point and therefore always gets a failed receipt,
// mirroring `nuka do`'s own setup/execution split (this task's spec,
// decision 4).
//
// A Then-position (`PickleStepType.OUTCOME`) step's own execution is never
// judged by what it observed on the wire (t2-trust-declaration task spec):
// this file used to demote an otherwise-"ok" status when a Then-bound step's
// execution measured a network write, but the write/read-method proxy that
// measurement rests on is not the semantics itself — GraphQL, RPC-over-POST,
// and many vendor query APIs run a semantically pure read through POST, and
// nukadoko has no way to tell those apart from the HTTP layer alone. A
// step's own `mutates` declaration is what nukadoko trusts instead; `nuka
// check`'s static check (src/check/feature-check.ts) still warns when a
// declared-mutating step is bound in Then position, but nothing in this file
// enforces it at runtime any more — the step just runs like any other.
//
// `policy: "read-only"` enforcement (m2pre-resultof task spec, decision 3)
// closes a gap this file always had: unlike cli/do.ts, `nuka run` never
// looked at the resolved environment's policy at all. Only the declared half
// of that check remains (t2-trust-declaration task spec, same reasoning as
// the Then-position paragraph above): a step whose *declared* `mutates` is
// `true` is refused before it ever runs — a "never began" outcome, alongside
// undefined/ambiguous, with `receipt: null` and the rest of the scenario
// skipped. There is no longer a measured backstop for a step that declares
// `mutates: false` yet is observed writing anyway — `observed.http_writes`
// is still tallied and still lands on the receipt (docs/spec.md
// "Receipts"), it just no longer decides `status`; a wrong declaration stays
// visible there and in http.jsonl for a report to catch, rather than failing
// the run that exposed it.
//
// `ctx.resultOf` (m2pre-resultof task spec, decisions 1-2): this file is the
// one place a pickle's result chain is held — a `Map` keyed by the Step
// object itself (not by name), updated only when a step's own status is
// `"ok"`. The chain is created fresh per scenario and never escapes this
// function, so it cannot leak between
// pickles; a step's own reader is wired into createStepContext's `resultOf`
// option as a plain closure over this map, and every value-returning read is
// reflected back afterward via `contextHandle.usedSnapshot()` onto that
// step's own receipt (`used`). Only a *typed* step's chain key ever exists
// (compat has no Step object, and no validated result to offer — see below),
// so this chain is exclusively typed-to-typed provenance, unchanged by this
// slice's compat additions (v1 builds no data bridge between compat and
// typed interop).
//
// Object identity survives a step file importing another step file
// (m2pre-module-identity task spec): src/discover/discover-steps.ts loads
// every file through one shared tsx module registration for the whole
// discovery run, so a step file's own relative import of another step
// file's default export is the same object discovery put in this chain's
// key space. See tests/resultof.test.ts's header comment for the
// empirical proof this relies on.
//
// m2b-compat-execution task spec: this file now also runs compat steps and
// Before/After hooks, closing m2a-compat-registry's two temporary
// asymmetries (`buildStepBindings`/`matchPickleStep`, src/run/match-step.ts,
// already match through compat entries; this file is where a *matched*
// compat entry now actually executes instead of being skipped). One World
// is constructed per pickle (item 4: "1 pickle = 1 World = 1 ctx"), shared
// by every compat step and hook in it, wrapping the exact same `ctx` a typed
// step's `run(ctx, args)` receives — so a typed step's `ctx.request()` and a
// compat step's `this.request` (after `await this.openRequest()`) are the
// identical Playwright object, cookies and all. A compat step's own
// execution is much simpler than a typed step's: no args/returns schema,
// so no binding-failure branch and no `chain` entry ever gets written for
// one (`result: null` always, per docs/spec.md "Receipts": "Compat steps
// record result: null" — regardless of what the glue function itself
// returned). Before/After hooks run against that same World, outside any
// step's own receipt boundary — `contextHandle.beginStep(scenarioDir)`
// before each hook phase redirects http.jsonl logging and the `observed`
// tally away from any step's own receipt dir (this task's spec, item 5: a
// hook's own network activity stays outside any step boundary, a documented
// v1 limit rather than a bug: it is neither measured on any step's
// receipt nor visible in the scenario record at all).
//
// m2d-allure-shim task spec: this file also owns `declaredCollector` (src/
// compat/declared.ts) — one per pickle, repointed as "the currently active
// declared collector" right after `instantiateCompatWorld` runs, and reset
// via its own `beginStep(dir)` at the same points `contextHandle.beginStep`/
// `worldInstrumentation.beginStep` already are: once per step (redirected to
// that step's own receipt dir) and once per *individual* Before/After hook
// invocation (redirected to `scenarioDir`, read right after that hook
// returns/throws) — kind-independent (a typed step's receipt gets this
// exactly like a compat step's does, since both the registered allure-js
// `TestRuntime` and a compat World's own attach/log/link read the same
// active pointer).
//
// m21b-compat-execution task spec: closes the "silent behavior change" gaps
// left in compat step/hook *execution* (as opposed to A's registration-time
// closures) — a compat step's or hook's own `{ timeout }` is now actually
// enforced (`runWithTimeout`, item 2), every Before/After hook is called
// with a real `HookParameter` instead of zero arguments (`buildHookParameter`,
// item 3), and a string return of `"pending"`/`"skipped"` or an apparent
// `done`-callback arity both fail loudly instead of silently passing (items
// 4-5) — all four checks apply only to compat steps and hooks, never to a
// typed step, whose fixed `run(ctx, args)` arity and zod-validated `returns`
// make none of cucumber-js's own conventions here relevant to it.
//
// m22-compat-run-scope task spec, item 1: `defaultTimeoutMs` (this run's own
// `setDefaultTimeout` value, or `undefined`) is threaded in from cli/run.ts
// and falls back only where a compat step's/hook's *own* `{ timeout }` is
// `undefined` (`?? defaultTimeoutMs` at each `runWithTimeout` call site
// below) — an own declaration always wins, matching cucumber-js. `undefined
// ?? undefined` stays `undefined`, so never calling `setDefaultTimeout`
// leaves every compat step/hook exactly as unbounded as before this task.
// `runWithTimeout`/`pendingOrSkippedMessage`/`doneCallbackMessage` are
// exported (unchanged otherwise) so cli/run.ts's own BeforeAll/AfterAll
// execution (this task's spec, item 2 — a run-scope hook, not a per-pickle
// one, so it does not belong in this file) reuses the exact same
// timeout-racing/message logic rather than a second, drifting copy of it.
//
// m4a-run-provenance task spec: `runId` and `git` are both computed once by
// the caller (cli/run.ts), before this run's own pickle loop, and threaded
// into every `runScenario` call unchanged — the same "measured once per
// run, not once per pickle" shape `targetVersion` above already has. This
// file only ever copies them onto each scenario record it writes.
//
// t7-compat-status-afterstep task spec: `runAfterStepHooks` (defined just
// above the pickle.steps loop it's called from) adds `AfterStep` execution —
// once per pickle step that actually ran, not once per scenario the way
// Before/After are — with the exact same non-breaking failure handling the
// After loop above already has (see that function's own header). Only a
// step that actually executed reaches it; a skipped/never-began step does
// not, matching this task's spec, item 2-3.

/** The declared-mutates read-only refusal message (this task's spec,
 * decision 3): matches cli/do.ts's own setup-phase rejection wording, since
 * this is the same fact about the same policy, just reached from `nuka run`
 * this time. */
function readOnlyDeclaredMutatesMessage(stepName: string, environment: string): string {
  return `Step "${stepName}" mutates state but environment "${environment}" has policy "read-only"`;
}

/** One pickle's own result chain: which Step object most recently finished
 * with `status: "ok"`, and what its validated result, receipt id, and own
 * step name were (this task's spec, decision 1). `stepName` (m6a-from-core
 * task spec, item 5) is carried alongside `receiptId` so a `used` entry
 * built from this chain — whether through `ctx.resultOf` or a `from`
 * injection — can cite the step name docs/spec.md "Receipts" asks for
 * without a second vocabulary lookup. */
interface ChainEntry {
  readonly result: unknown;
  readonly receiptId: string;
  readonly stepName: string;
}

export interface RunScenarioOptions {
  readonly rootDir: string;
  /** Already resolved for this run's target environment (baseURL swapped in,
   * same as cli/do.ts passes to createStepContext) — see cli/run.ts. */
  readonly config: NukadokoConfig;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
  /** This pickle's own feature file, already parsed (src/feature/load-
   * features.ts's `parseFeatureSource`, m21b-compat-execution task spec,
   * item 3) — every Before/After hook's `HookParameter.gherkinDocument`
   * below is this exact object, never a partial/reconstructed stand-in
   * (this task's spec: no cutting corners with a partial stand-in object). */
  readonly gherkinDocument: GherkinDocument;
  readonly vocabulary: Vocabulary;
  readonly bindings: readonly StepBinding[];
  /** The same `CheckedPattern[]` `nuka check` builds via
   * src/check/binding-check.ts's `checkBindings` (cli/run.ts's own setup
   * phase calls it once for the whole run, not once per pickle) — this
   * pickle's own from-order guard (below) resolves each of its steps' bound
   * names through these, the exact seam `src/check/from-order.ts`'s own
   * header explains (m6b-from-check task spec, item 3: `nuka check` and
   * `nuka run` share one judgment, never two). */
  readonly patterns: readonly CheckedPattern[];
  /** This `nuka run` invocation's own id (m4a-run-provenance task spec,
   * decision 1) — generated once by the caller (cli/run.ts), before any
   * pickle runs, and copied verbatim onto every scenario record this
   * invocation writes (`ScenarioRecord.run_id`). */
  readonly runId: string;
  /** The commit and cleanliness of the working tree when this run started
   * (m4a-run-provenance task spec, decisions 2 and 4) — probed once by the
   * caller (`src/run/probe-git.ts`), before any pickle runs, and copied
   * verbatim onto every scenario record this invocation writes
   * (`ScenarioRecord.git`). `undefined` outside a git repository or when
   * the probe itself failed; never causes this run to fail. */
  readonly git: GitState | undefined;
  readonly environment: string;
  /** The resolved environment's `policy` (cli/run.ts's `resolvedEnv.policy`)
   * — `"read-only"` refuses a declared-mutating step before it runs (this
   * task's spec, decision 3); `undefined` means no restriction. A step
   * declared `mutates: false` that is nonetheless measured writing is no
   * longer demoted for it (t2-trust-declaration task spec) — the
   * declaration is trusted, and `observed.http_writes` on its receipt is
   * where a wrong one stays visible instead. */
  readonly policy: "read-only" | undefined;
  readonly targetVersion: string | undefined;
  readonly session: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: SecretSet;
  /** This scenario's starting storageState, already read from the session
   * file by the caller (this task's spec, decision 8: read at each
   * scenario's own start, so an earlier scenario's save in the same run is
   * visible to a later one) — `null` for no `--session` or a session's
   * first-ever use. */
  readonly storageState: StorageState | null;
  /** Where to persist this scenario's ending storageState, or `null` when
   * `--session` wasn't given (nothing is read or written). */
  readonly sessionFilePath: string | null;
  /** Constructs this pickle's own World (src/discover/discover-steps.ts's
   * `DiscoveryResult.instantiateCompatWorld`, m2b-compat-execution task spec,
   * item 4), already wrapped for measurement + this run's own `defineWorld`
   * schemas (m2c-typed-world task spec, items 1-2), with its `attach`/`log`/
   * `link` wired to the given declared collector (m2d-allure-shim task spec,
   * item 4). Called exactly once per pickle, with this function's own
   * freshly created `declaredCollector`. */
  readonly instantiateCompatWorld: (
    ctx: StepContext,
    declaredCollector: DeclaredCollector,
  ) => InstantiatedWorld;
  /** Every registered Before/After hook (src/discover/discover-steps.ts's
   * `DiscoveryResult.compatHooks`) — already validated for tag-expression
   * support by the caller (cli/run.ts's setup phase); this file only
   * filters by this pickle's own tags (this task's spec, item 5). */
  readonly compatHooks: readonly HookRegistration[];
  /** This run's own `setDefaultTimeout` value (src/discover/discover-
   * steps.ts's `DiscoveryResult.defaultTimeoutMs`), or `undefined` if it was
   * never called (m22-compat-run-scope task spec, item 1) — applied as the
   * fallback for a compat step's or Before/After hook's own `timeoutMs`
   * wherever that is `undefined`; an own declaration always wins. Not
   * applied to a typed step, which has no timeout mechanism at all. */
  readonly defaultTimeoutMs: number | undefined;
}

function undefinedStepMessage(text: string): string {
  return `No step definition matches "${text}"; run \`nuka scaffold <name>\` to add one`;
}

function ambiguousStepMessage(text: string, stepNames: readonly string[]): string {
  return `"${text}" matches more than one step: ${[...stepNames].sort().join(", ")}`;
}

// --- m6a-from-core task spec, item 4: `from` injection (scenario path
// only — `nuka do` has no chain, docs/spec.md "Chaining steps": "Under
// `nuka do` there is no scenario and therefore no chain"). ---

/**
 * Fills `value`'s still-unfilled args keys from `step`'s own `from`
 * declaration, using this pickle's own chain (this task's spec, item 4):
 * capture always wins (a key `bindStepArgs` already put something in —
 * including from a table/docstring — is left untouched, `value[key] !==
 * undefined`), and a key whose upstream hasn't yet produced a successful
 * result *in this scenario* is left unfilled too — nukadoko never runs the
 * upstream step for you (docs/spec.md "Chaining steps": "One thing `from`
 * deliberately does not do: run the upstream step for you"), so a missing
 * dependency is a feature-file mistake to fix, not one this function papers
 * over.
 *
 * A key naming several candidate producers (m7a-from-alternatives task spec,
 * item 2) looks for whichever *one* of them has a chain entry — the pre-
 * execution guard (`checkFromOrder`, called before this pickle's steps ever
 * run) already required exactly one candidate to be bound earlier, so this
 * function itself never *chooses* among candidates; it only ever finds zero
 * (upstream hasn't produced a result yet — the pre-existing case, generalized
 * to "none of the candidates has") or one. Finding two or more here would
 * mean that guard was bypassed or has a bug — not a case to resolve with a
 * rule (this task's spec, item 2: "到達不能なはずの状態に出会ったら、規則で
 * 解決せず失敗させること" — no first-found, no most-recent-across-different-
 * steps; fail loudly instead of inventing the priority docs/spec.md says
 * `from` deliberately does not have).
 *
 * Mutates `value` in place (the same object `began.rawArgs` already points
 * at, this task's spec: the receipt's own `args` should show what the step
 * actually ran with, injected keys included — otherwise a reader could never
 * tell an injected value apart from one that was simply never validated).
 * Every key it *does* fill is reported to `recordUsed` (this task's spec,
 * item 5) — the same collector `ctx.resultOf` itself writes into, so a step
 * that is both injected into and separately calls `ctx.resultOf` still ends
 * up with one deduplicated `used` list. Every key it *cannot* fill is
 * returned (key -> the still-unfilled key's candidate step name(s), joined
 * when there is more than one, or a description of the problem if a
 * candidate was never itself named by `vocabulary` — see `stepNameOf`'s own
 * comment above) so the caller can name it if args validation goes on to
 * fail because of it (this task's spec, item 4: "the message should be
 * better than the hand-written era" — name which key, from which step).
 */
function injectFrom(
  value: Record<string, unknown>,
  step: Step,
  chain: ReadonlyMap<Step, ChainEntry>,
  stepNameOf: ReadonlyMap<Step, string>,
  recordUsed: (receiptId: string, stepName: string, result: unknown) => void,
): Map<string, string> {
  const stillMissing = new Map<string, string>();
  for (const [key, entry] of Object.entries(step.from)) {
    if (value[key] !== undefined) {
      // Capture (or a table/docstring) already filled this key — `from`
      // only ever supplies a key the pattern itself left unfilled (this
      // task's spec, item 4, bullet 1; docs/spec.md "Chaining steps": "A
      // pattern capture still wins").
      continue;
    }
    const candidates = fromCandidates(entry);
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
    recordUsed(chainEntry.receiptId, chainEntry.stepName, chainEntry.result);
  }
  return stillMissing;
}

/**
 * Names which still-missing `from` key(s) actually caused `issues` (this
 * task's spec, item 4) — not every key `injectFrom` couldn't fill is
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

// --- m21b-compat-execution task spec, items 2, 4, 5: compat step/hook
// execution honesty (only compat entries and Before/After hooks — the audit
// this task closes is entirely about hand-written, cucumber-js-style glue;
// a typed step's `run(ctx, args)` has a fixed arity and a zod-validated
// return, so none of these three checks apply to one). ---

/** Item 2's failure message: names which timeout fired (a step's own
 * `{ timeout }` vs a hook's), on what, and the configured value. Not
 * exported — only `runWithTimeout` below builds one, and that function
 * itself is what cli/run.ts's own BeforeAll/AfterAll reuses (see this
 * file's own header, m22-compat-run-scope task spec addendum). */
function timeoutMessage(kind: "Step" | "Hook", name: string, timeoutMs: number): string {
  return `${kind} "${name}" timed out after ${timeoutMs}ms (its own registered timeout)`;
}

/** Item 4: cucumber-js interprets the string returns `"pending"`/`"skipped"`
 * as their own outcomes; nukadoko's receipt/record schema has no such status
 * (implementing it for real is explicitly out of this task's scope), so
 * rather than silently passing through as success, a step/hook that returns
 * one of these two strings is failed with a message a migrator can act on.
 * Exported (m22-compat-run-scope task spec addendum) so cli/run.ts's own
 * BeforeAll/AfterAll execution reports the exact same wording for the exact
 * same fact, rather than a second copy of this message. */
export function pendingOrSkippedMessage(kind: "Step" | "Hook", name: string, value: string): string {
  return (
    `${kind} "${name}" returned ${JSON.stringify(value)}, which nukadoko does not interpret ` +
    `as pending/skipped (unlike cucumber-js). See docs/migration.md`
  );
}

/** Item 5: cucumber-js infers a `done` callback from a glue function
 * declaring one more parameter than it is actually called with, and passes
 * that extra argument a callback nukadoko never provides. Detected by arity
 * *before* calling the function at all — calling it would already be the
 * silent failure this closes (the callback never fires, the function
 * "succeeds" immediately having done none of its real work yet, and that
 * work keeps running unobserved after this step/hook is already recorded).
 * Exported for the same reason as `pendingOrSkippedMessage` above (m22-
 * compat-run-scope task spec addendum) — cli/run.ts's own BeforeAll/AfterAll
 * arity check reuses this exact wording. */
export function doneCallbackMessage(kind: "Step" | "Hook", name: string): string {
  return (
    `${kind} "${name}" appears to expect a done() callback (it declares more parameters ` +
    `than nukadoko passes it). nukadoko has no callback form; rewrite it to return a ` +
    `Promise (async/await). See docs/migration.md`
  );
}

/**
 * Races `run()` against `timeoutMs` (when given) and returns whichever
 * settles first. Honest limit, spelled out here because it is easy to miss
 * (this task's spec, item 2): JavaScript cannot cancel an in-flight
 * Promise — a timed-out call's own body keeps executing to completion in
 * the background no matter what this function returns. All this actually
 * guarantees is that the step/hook that started it is recorded as failed
 * and `runScenario` moves on to whatever comes next; it does not stop the
 * timed-out work itself.
 *
 * `run()`'s own promise is given a no-op `.catch` up front regardless of
 * which side of the race wins: if it eventually rejects *after* losing to
 * the timeout, that rejection would otherwise be "unhandled" from Node's
 * point of view (Node terminates the whole process for an unhandled
 * rejection by default since Node 15) — precisely the kind of hard crash a
 * per-step timeout must never cause.
 *
 * The timer itself is always cleared, on every path, so a step/hook that
 * finishes in time never leaks a pending Node timer (this task's spec: the
 * timer must always be cleared).
 *
 * Exported (m22-compat-run-scope task spec addendum) so cli/run.ts's own
 * BeforeAll/AfterAll execution races against the exact same logic a
 * scenario's own compat step/hook already does, rather than a second,
 * potentially-drifting copy of it — a run-scope hook is still "a compat
 * hook with a `{ timeout }`" as far as this function is concerned, it is
 * only *where* it runs (once per `nuka run`, not once per pickle) that
 * differs, and that difference lives entirely in the caller.
 */
export async function runWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
  kind: "Step" | "Hook",
  name: string,
): Promise<T> {
  if (timeoutMs === undefined) {
    return run();
  }
  const inFlight = run();
  inFlight.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CompatTimeoutError(timeoutMessage(kind, name, timeoutMs))),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([inFlight, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Classifies a compat step's/hook's own thrown value into the closed
 * `error.kind` enum (m3a-receipt-kinds task spec, decisions 1-2) —
 * identified by type, never by matching the thrown value's own message text
 * (this task's spec: judging by a string match on the message is not
 * allowed). Only
 * `CompatTimeoutError` (`runWithTimeout`, above, always constructed by this
 * very module) and a `WorldWriteValidationError` (a declared World key's
 * write, src/compat/world-instrumentation.ts — checked via
 * `isWorldWriteValidationError`'s own brand, not `instanceof`, since that
 * error is reached through discovery's own scoped tsx import and
 * `instanceof` would silently miss it there; see that function's own header)
 * are identifiable this way; anything else — including a non-`Error` thrown
 * value — falls back to `"step_error"` (this task's spec: default to
 * step_error whenever classification is uncertain). Not applied to a typed step's own throw: a typed
 * step never touches a World or `runWithTimeout` (no `this`, no timeout
 * mechanism — this file's own header), so that catch site hardcodes
 * `"step_error"` directly rather than call through here for a case that can
 * never actually occur. */
function classifyCaughtError(error: unknown): ErrorKind {
  if (error instanceof CompatTimeoutError) return "timeout";
  if (isWorldWriteValidationError(error)) return "world_invalid";
  return "step_error";
}

/** Builds this hook invocation's own `HookParameter` (this task's spec, item
 * 3) — `result` is included only for an After hook (`resultStatus !==
 * undefined`), matching cucumber-js's own convention of never setting it for
 * Before. */
function buildHookParameter(
  gherkinDocument: GherkinDocument,
  pickle: Pickle,
  testCaseStartedId: string,
  resultStatus: "PASSED" | "FAILED" | undefined,
): HookParameter {
  return {
    gherkinDocument,
    pickle,
    testCaseStartedId,
    willBeRetried: false,
    ...(resultStatus !== undefined ? { result: { status: resultStatus } } : {}),
  };
}

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioRecord> {
  const {
    rootDir,
    config,
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
    session,
    env,
    secrets,
    storageState,
    sessionFilePath,
    instantiateCompatWorld,
    compatHooks,
    defaultTimeoutMs,
  } = options;

  const scenarioId = generateScenarioId();
  const relativeScenarioDir = path.join(config.stateDir, "scenarios", scenarioId);
  const scenarioDir = path.join(rootDir, relativeScenarioDir);
  await mkdir(scenarioDir, { recursive: true });

  const startedAt = new Date();

  // m6b-from-check task spec, item 2: the pre-execution guard docs/spec.md
  // "Chaining steps" promises ("`nuka run`, before it executes that
  // scenario") — the exact judgment `nuka check` makes (src/check/from-
  // order.ts's own header), asked here before anything else in this pickle
  // happens. Deliberately placed before `chain`/`stepNameOf`/
  // `contextHandle`/the World are ever created, not merely before the
  // per-step loop below: a violation found anywhere in this pickle fails the
  // *whole* scenario without executing any of its steps, including ones
  // textually before the offending line (this task's spec: "実行せずに失敗
  // させる") — so no step's own `run` ever gets a chance to call
  // `ctx.page()`, and this scenario's own browser session is never opened.
  // Every other pickle in this `nuka run` invocation is untouched (cli/
  // run.ts's own pickle loop calls this function once per pickle,
  // independently).
  //
  // m7b-unfillable-key task spec, item 2: `checkUnfillableKeys` (src/check/
  // unfillable-key.ts) joins `checkFromOrder` at this exact guard — same
  // judgment `nuka check` makes, same "never began" shape, one shared list of
  // per-step messages below rather than a second guard block.
  const orderIssues = checkFromOrder(pickle, vocabulary, patterns);
  const unfillableKeyIssues = checkUnfillableKeys(pickle, vocabulary, patterns);
  if (orderIssues.length > 0 || unfillableKeyIssues.length > 0) {
    // Mirrors the existing undefined-step shape (docs/spec.md "an execution
    // that never began must not be citable"): every pickle step still gets
    // its own `steps` entry, `receipt: null` throughout since nothing ever
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
    const stepRecords: ScenarioStepRecord[] = pickle.steps.map((pickleStep, index) => {
      const messages = issuesByStepIndex.get(index);
      if (messages === undefined) {
        return { text: pickleStep.text, status: "skipped", receipt: null };
      }
      return {
        text: pickleStep.text,
        status: "failed",
        receipt: null,
        error: { message: messages.join("; ") },
      };
    });
    const finishedAt = new Date();
    const record: ScenarioRecord = {
      scenario_id: scenarioId,
      run_id: runId,
      feature: relativeFeaturePath,
      scenario: pickle.name,
      line: pickle.location?.line ?? 0,
      status: "failed",
      environment,
      ...(targetVersion !== undefined ? { target_version: targetVersion } : {}),
      session,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      steps: stepRecords,
      hooks: [],
      ...(git !== undefined ? { git } : {}),
      evidence: { dir: relativeScenarioDir, screenshots: [] },
    };
    const redactedRecord = redact(record, secrets) as ScenarioRecord;
    await writeScenarioRecord(scenarioDir, redactedRecord);
    return redactedRecord;
  }

  // This scenario's own result chain (this task's spec, decision 1) — kept
  // here, not inside create-context.ts, so it never outlives this one
  // pickle's execution. `readChain` is the plain closure createStepContext
  // wraps into `ctx.resultOf`; this function is the only place that ever
  // writes to `chain`.
  const chain = new Map<Step, ChainEntry>();
  function readChain(step: Step): ChainEntry | undefined {
    return chain.get(step);
  }

  // Every typed step's own Step object, keyed by its vocabulary name (m6a-
  // from-core task spec, items 4, 6) — built once per pickle from the same
  // `vocabulary` every pickle in this `nuka run` invocation shares. Doubles
  // as the "is this Step object one discovery actually registered" predicate
  // `ctx.resultOf`'s unregistered-Step throw needs (item 6: `stepNameOf.has`
  // answers exactly that question — a Step this map doesn't have a name for
  // is, by construction, not `===` anything discovery put in the vocabulary)
  // and as the name lookup a `from` injection's own "still missing" error
  // message uses (item 4) to name which upstream step a key should have come
  // from, whether or not that step has run yet in this scenario.
  const stepNameOf = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      stepNameOf.set(entry.step, entry.name);
    }
  }

  const contextHandle = createStepContext({
    config,
    evidenceDir: scenarioDir,
    env,
    secrets,
    storageState: storageState ?? undefined,
    resultOf: readChain,
    isRegisteredStep: (step) => stepNameOf.has(step),
  });

  const stepRecords: ScenarioStepRecord[] = [];
  const hookRecords: ScenarioHookRecord[] = [];
  let scenarioFailed = false;

  /**
   * Shared by the typed and compat branches below (this task's spec, item
   * 2's asymmetry-closing and item 3's compat receipt shape): records this
   * step in `chain` when `chainKey` is given and the final status is `"ok"`
   * (typed only — `undefined` for a compat step, this task's spec, item 4:
   * a World is shared compat-to-compat only), then builds, redacts, and writes the receipt
   * and this step's own scenario-record entry. `observed.http_writes` (every
   * network path this ctx opens tallies into whichever kind of step opened
   * it, typed or compat alike) is recorded on every receipt below regardless
   * of position or policy, but no longer demotes `status` from it
   * (t2-trust-declaration task spec: measurement stays a record, never a
   * verdict — see this file's own header). A closure over this function's
   * own `chain`/`contextHandle`/`environment`/`policy`/`targetVersion`/
   * `session`/`scenarioId`/`secrets`, and mutates the outer
   * `scenarioFailed`/`stepRecords` — kept as a nested function rather than
   * a free one specifically so it can reach all of that without threading
   * every one of those through its own parameter list.
   */
  async function finishExecutedStep(
    pickleStep: PickleStep,
    begun: { readonly receiptId: string; readonly receiptDir: string; readonly relativeReceiptDir: string },
    stepStartedAt: Date,
    outcomeStepName: string,
    initialStatus: "ok" | "failed",
    initialErrorMessage: string,
    // `undefined` exactly when `initialStatus` is `"ok"` — a real `ErrorKind`
    // is required whenever the caller already knows this step failed for its
    // own reason (args/binding/returns/its own throw), m3a-receipt-kinds
    // task spec, decision 1.
    initialErrorKind: ErrorKind | undefined,
    result: unknown,
    rawArgs: unknown,
    chainKey: Step | undefined,
    // This step's own declared `mutates` (typed) or `null` (compat, which
    // has no declaration at all) — this task's spec, decision 3.
    mutates: boolean | null,
  ): Promise<void> {
    const status = initialStatus;
    const errorMessage = initialErrorMessage;
    const errorKind = initialErrorKind;

    // `observed.http_writes`/`http_reads` are tallied every occurrence,
    // typed or compat alike, and always land on the receipt below — this is
    // a record, not a verdict (t2-trust-declaration task spec): nukadoko no
    // longer demotes `status` for what a step's execution measured, whether
    // that step is bound in Then position or running under a read-only
    // policy. What's left of that enforcement is entirely declared: the
    // read-only refusal above (before this step ever ran) and `nuka
    // check`'s static Then-position warning, neither of which this function
    // touches.
    const observed = contextHandle.observedCounts();
    const usedEntries = contextHandle.usedSnapshot();
    // Labels `ctx.section` was called with since the current step boundary
    // began (t3-sections task spec, decisions 1-2, 4) — reset at the same
    // `beginStep` calls `observed`/`used` already are, so a step never
    // inherits an earlier step's labels in this shared-`ctx` pickle.
    const sectionLabels = contextHandle.sectionsSnapshot();
    // Every `ctx.poll` call that finished since the current step boundary
    // began, in completion order (ctx-poll-receipt task spec) — same
    // "read after execution, whatever the outcome" shape as `sectionLabels`
    // right above; a poll that timed out or whose `fn` threw is exactly the
    // record a failed step's receipt needs.
    const pollRecords = contextHandle.pollsSnapshot();
    // Env var names `ctx.requireEnv` was called with since the current step
    // boundary began, including a call that went on to throw
    // `MissingEnvError` (env-reads-and-mutates-doc task spec, item A) —
    // reset at the same `beginStep` call `observed`/`used`/`sections`
    // already are, so a step never inherits an earlier step's required
    // names in this shared-`ctx` pickle. Always empty for a compat step (no
    // `requireEnv` counterpart on `this`), so `required_env` is naturally
    // omitted for one below, the same way `sections` already is.
    const requiredEnv = contextHandle.envReadsSnapshot();
    // World reads/writes tallied since the current step boundary began (m2c-
    // typed-world task spec, item 3) — always empty for a typed step (no
    // `this`), so the `world` field below is naturally omitted for one,
    // with no separate kind check needed.
    const worldReadsWrites = worldInstrumentation.snapshot();
    // What this step (kind-independent) declared through the allure-js
    // runtime shim or a compat World's own attach/log/link (m2d-allure-shim
    // task spec, items 2-3) — `undefined` when nothing was ever recorded
    // this step, omitted from the receipt the same way `used`/`world` are.
    const declared = declaredCollector.snapshot();

    // Only a step whose *final* status is "ok" ever becomes readable via
    // `ctx.resultOf`, and only when `chainKey` is given at all (typed only).
    if (status === "ok" && chainKey !== undefined) {
      chain.set(chainKey, { result, receiptId: begun.receiptId, stepName: outcomeStepName });
    }

    const stepFinishedAt = new Date();
    const httpLogExists = existsSync(path.join(begun.receiptDir, "http.jsonl"));

    const receipt: Receipt =
      status === "ok"
        ? {
            receipt_id: begun.receiptId,
            step: outcomeStepName,
            kind: "run",
            args: rawArgs,
            result,
            status: "ok",
            environment,
            target_version: targetVersion,
            session,
            scenario: scenarioId,
            started_at: stepStartedAt.toISOString(),
            finished_at: stepFinishedAt.toISOString(),
            evidence: {
              dir: begun.relativeReceiptDir,
              screenshots: [],
              ...(httpLogExists ? { http: "http.jsonl" } : {}),
            },
            observed,
            mutates,
            // `omitUsedResults` (fb3-used-result task spec, decision 2): an
            // "ok" receipt keeps `used`'s original `{ receipt, step }` shape
            // — the upstream's own result is only worth a second look on a
            // *failed* receipt, the failed branch just below.
            ...(usedEntries.length > 0 ? { used: omitUsedResults(usedEntries) } : {}),
            ...(sectionLabels.length > 0 ? { sections: sectionLabels } : {}),
            ...(pollRecords.length > 0 ? { polls: pollRecords } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
              ? { world: worldReadsWrites }
              : {}),
            ...(declared ? { declared } : {}),
          }
        : {
            receipt_id: begun.receiptId,
            step: outcomeStepName,
            kind: "run",
            args: rawArgs,
            // `errorKind` is guaranteed set by this point: the caller always
            // passes one alongside `initialStatus === "failed"`, and this
            // function no longer demotes an "ok" status to "failed" itself
            // (t2-trust-declaration task spec). The `?? "step_error"`
            // fallback is a belt-and-braces default only, matching this
            // task's own principle of defaulting to step_error whenever
            // classification is uncertain — it should never actually be reached.
            error: { message: errorMessage, kind: errorKind ?? "step_error" },
            status: "failed",
            environment,
            target_version: targetVersion,
            session,
            scenario: scenarioId,
            started_at: stepStartedAt.toISOString(),
            finished_at: stepFinishedAt.toISOString(),
            evidence: {
              dir: begun.relativeReceiptDir,
              screenshots: [],
              ...(httpLogExists ? { http: "http.jsonl" } : {}),
            },
            observed,
            mutates,
            // Unstripped here, unlike the "ok" branch above (fb3-used-result
            // task spec, decisions 1-2): a failed step's receipt is exactly
            // where a reader most needs "what upstream value did this read",
            // without opening a second receipt.json to find out.
            ...(usedEntries.length > 0 ? { used: usedEntries } : {}),
            ...(sectionLabels.length > 0 ? { sections: sectionLabels } : {}),
            ...(pollRecords.length > 0 ? { polls: pollRecords } : {}),
            ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
            ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
              ? { world: worldReadsWrites }
              : {}),
            ...(declared ? { declared } : {}),
          };

    // Redacted once, as one object, same as `nuka do` (this task's spec,
    // decision 6): receipt.json must never be able to disagree with the
    // scenario record about what got redacted.
    const redactedReceipt = redact(receipt, secrets) as Receipt;
    await writeReceipt(begun.receiptDir, redactedReceipt);

    if (status === "failed") {
      scenarioFailed = true;
    }
    stepRecords.push({
      text: pickleStep.text,
      status: status === "ok" ? "passed" : "failed",
      receipt: begun.receiptId,
      ...(status === "failed" ? { error: { message: errorMessage } } : {}),
    });
  }

  // --- Hooks + World (m2b-compat-execution task spec, items 4-5) ---
  // One World per pickle, shared by every compat step and hook that runs in
  // it, wrapping this same `contextHandle.ctx` a typed step's `run` also
  // receives (item 4: "1 pickle = 1 World = 1 ctx"). `worldInstrumentation`
  // is this same World's own measurement handle (m2c-typed-world task spec,
  // items 1-3) — advanced (`beginStep()`) at the exact same points
  // `contextHandle.beginStep()` is called below, and read (`snapshot()`)
  // inside `finishExecutedStep` and this function's own backstop catch.
  // m2d-allure-shim task spec, items 1-2: one collector for this whole
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
  const { world, instrumentation: worldInstrumentation } = instantiateCompatWorld(
    contextHandle.ctx,
    declaredCollector,
  );
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
  // AfterStep hooks (t7-compat-status-afterstep task spec, item 2-1): same
  // tag-filter as Before/After. Kept in registration order, unlike After's
  // own reversal above — that reversal exists because After is teardown for
  // Before's setup and cucumber-js unwinds teardown in the opposite order
  // setup ran in; AfterStep has no such setup/teardown pairing (each
  // AfterStep hook is independent of every other one), so there is no
  // "unwind" for a reversal to model.
  const afterStepHooks = compatHooks.filter(
    (hook) => hook.type === "after_step" && hookApplies(hook.tags, pickleTags),
  );

  // Hooks get their own boundary, never a step's own receipt dir (this
  // task's spec, item 5: a hook's own network stays outside any step
  // boundary) — redirected
  // to the scenario dir itself, the same place `httpLogDir` already starts
  // out pointed at before any step's own `beginStep()` call ever runs.
  contextHandle.beginStep(scenarioDir);
  // Same step-boundary point for the World's own instrumentation (m2c-typed-
  // world task spec, item 1's reconcile + item 3's per-boundary reset) — a
  // Before hook's own World reads/writes get tallied here but are discarded
  // by the very next `beginStep()` call (before step 1), so they are never
  // attributed to any step's receipt, the same isolation `observed`/`used`
  // already give hooks.
  worldInstrumentation.beginStep();
  for (const hook of beforeHooks) {
    // m2d-allure-shim task spec, item 4: each hook gets its own declared
    // boundary — reset right before it runs, read right after — so one
    // hook's own facade/World-channel calls land on exactly that hook's own
    // `hookRecords` entry, never smeared across its sibling Before hooks.
    // Independent of `contextHandle`/`worldInstrumentation`'s own
    // once-per-phase boundary above (observed/world stay a documented v1
    // limit for hooks, unchanged by this task — see this file's own
    // header).
    declaredCollector.beginStep(scenarioDir);
    // Item 3: `HookParameter.result` is absent for a Before hook (cucumber-js
    // never sets it there either — a scenario's outcome isn't known yet).
    const hookParameter = buildHookParameter(gherkinDocument, pickle, scenarioId, undefined);
    // m3a-receipt-kinds task spec, decision 2: the arity check and the
    // pending/skipped return are both classified `"unsupported"` directly,
    // at the exact point each is detected — set on `hookStatus`/
    // `hookErrorKind` rather than thrown, so they never need to be told
    // apart from a hook's own throw (`timeout`/`world_invalid`/`step_error`,
    // via `classifyCaughtError`) inside a shared catch block afterward. This
    // mirrors the compat step branch's own arity/pending-skipped checks
    // further down in this file, which already work the same non-throwing
    // way.
    let hookStatus: "ok" | "failed" = "ok";
    let hookErrorMessage = "";
    let hookErrorKind: ErrorKind = "step_error";
    if (hook.fn.length >= 2) {
      // Item 5's arity check, before the call itself (see runWithTimeout's
      // own header for why calling it at all would already be the failure).
      hookStatus = "failed";
      hookErrorMessage = doneCallbackMessage("Hook", "Before");
      hookErrorKind = "unsupported";
    } else {
      try {
        const returnValue = await runWithTimeout(
          () => Promise.resolve(hook.fn.call(world, hookParameter)),
          hook.timeoutMs ?? defaultTimeoutMs,
          "Hook",
          "Before",
        );
        if (returnValue === "pending" || returnValue === "skipped") {
          hookStatus = "failed";
          hookErrorMessage = pendingOrSkippedMessage("Hook", "Before", returnValue);
          hookErrorKind = "unsupported";
        }
      } catch (error) {
        hookStatus = "failed";
        hookErrorMessage = error instanceof Error ? error.message : String(error);
        hookErrorKind = classifyCaughtError(error);
      }
    }
    const declared = declaredCollector.snapshot();
    if (hookStatus === "ok") {
      hookRecords.push({ type: "before", status: "ok", ...(declared ? { declared } : {}) });
    } else {
      hookRecords.push({
        type: "before",
        status: "failed",
        error: { message: hookErrorMessage, kind: hookErrorKind },
        ...(declared ? { declared } : {}),
      });
      scenarioFailed = true;
      // Stop at the first Before failure (this task's spec, item 5: a Before
      // failure skips every step): this scenario's setup already didn't
      // complete, so there is nothing left for a later Before hook to
      // prepare into.
      break;
    }
  }

  /**
   * Runs every applicable AfterStep hook for one pickle step that actually
   * executed (t7-compat-status-afterstep task spec, item 2-3) — the three
   * call sites below are exactly the three places a step's own execution
   * reaches a final `"ok"`/`"failed"` status: the typed branch, the compat
   * branch, and the general per-step backstop catch's `began !== null` arm.
   * A step that never began at all (undefined, ambiguous, the read-only
   * declared-mutates refusal, or the backstop's own `began === null` arm)
   * has no receipt and no "after" for this hook to run at, so none of those
   * call this function — the same reasoning already covers a step this
   * scenario skipped outright (the `if (scenarioFailed)` check at the very
   * top of the loop below never reaches this function either, since it
   * `continue`s before matching/running anything).
   *
   * `stepStatus` is that one step's own outcome, not the scenario's running
   * one (item 2-2: `HookParameter.result` reflects "the step itself", the
   * same distinction `buildHookParameter`'s own header draws for After).
   *
   * Failure handling mirrors the After loop above exactly (item 2-5: read
   * that loop before touching this one) — an AfterStep hook's own failure
   * still lets every other AfterStep hook for this same step run (no
   * `break`, unlike the Before loop above: Before breaks because its own
   * phase failing leaves nothing left to prepare into, but a sibling
   * AfterStep hook for this exact step is just as reachable as it always
   * was) and only sets `scenarioFailed` — which the next iteration of the
   * pickle.steps loop below reads, skipping every remaining step exactly as
   * if that step itself had failed.
   */
  async function runAfterStepHooks(stepIndex: number, stepStatus: "ok" | "failed"): Promise<void> {
    if (afterStepHooks.length === 0) {
      return;
    }
    // Same boundary redirect as the Before/After loops (this file's own
    // header, m2b-compat-execution task spec, item 5): a hook's own network
    // activity stays outside any step's own receipt boundary. Without this,
    // an AfterStep hook's own requests would keep writing into the step it
    // just ran after's own http.jsonl, even though that step's receipt (and
    // its `observed` tally) was already built and written by
    // `finishExecutedStep` before this function is ever called.
    contextHandle.beginStep(scenarioDir);
    worldInstrumentation.beginStep();
    const hookParameter = buildHookParameter(
      gherkinDocument,
      pickle,
      scenarioId,
      stepStatus === "ok" ? "PASSED" : "FAILED",
    );
    for (const hook of afterStepHooks) {
      // Same per-hook declared boundary as the Before/After loops (m2d-
      // allure-shim task spec, item 4) — reset right before, read right
      // after, so one AfterStep hook's own declared data never bleeds into a
      // sibling's.
      declaredCollector.beginStep(scenarioDir);
      let hookStatus: "ok" | "failed" = "ok";
      let hookErrorMessage = "";
      let hookErrorKind: ErrorKind = "step_error";
      if (hook.fn.length >= 2) {
        hookStatus = "failed";
        hookErrorMessage = doneCallbackMessage("Hook", "AfterStep");
        hookErrorKind = "unsupported";
      } else {
        try {
          const returnValue = await runWithTimeout(
            () => Promise.resolve(hook.fn.call(world, hookParameter)),
            hook.timeoutMs ?? defaultTimeoutMs,
            "Hook",
            "AfterStep",
          );
          if (returnValue === "pending" || returnValue === "skipped") {
            hookStatus = "failed";
            hookErrorMessage = pendingOrSkippedMessage("Hook", "AfterStep", returnValue);
            hookErrorKind = "unsupported";
          }
        } catch (error) {
          hookStatus = "failed";
          hookErrorMessage = error instanceof Error ? error.message : String(error);
          hookErrorKind = classifyCaughtError(error);
        }
      }
      const declared = declaredCollector.snapshot();
      if (hookStatus === "ok") {
        hookRecords.push({ type: "after_step", step_index: stepIndex, status: "ok", ...(declared ? { declared } : {}) });
      } else {
        hookRecords.push({
          type: "after_step",
          step_index: stepIndex,
          status: "failed",
          error: { message: hookErrorMessage, kind: hookErrorKind },
          ...(declared ? { declared } : {}),
        });
        // No `break` — see this function's own header (item 2-5: same
        // non-breaking failure handling as the After loop above).
        scenarioFailed = true;
      }
    }
  }

  for (const [stepIndex, pickleStep] of pickle.steps.entries()) {
    if (scenarioFailed) {
      // item 2-3's own regression case: a step skipped because an earlier
      // one already failed never executes, so it never reaches any of the
      // three `runAfterStepHooks` call sites below either — this `continue`
      // is exactly where that "no after for a skipped step" boundary lives.
      stepRecords.push({ text: pickleStep.text, status: "skipped", receipt: null });
      continue;
    }

    // General per-step backstop (fix-scenario-step-backstop task spec,
    // decisions 1-2): everything from matching this step's text through
    // writing its receipt sits inside the try below, so ANY unexpected
    // throw still leaves this pickle's own scenario record written
    // (docs/spec.md "Running": once a pickle begins executing, every step
    // gets a record entry) instead of crashing the whole `nuka run`
    // invocation uncaught. The violation this backstop exists for: a
    // custom `config.parameterTypes` transformer's throw propagates
    // unchanged straight out of match-step.ts's `matchPickleStep` (that
    // file's own header comment, decision 5 — cucumber-expressions itself
    // never catches a transformer call, and that module deliberately
    // doesn't either), and nothing between it and here caught it before
    // this task. This backstop changes nothing about any failure already
    // handled by name below (undefined/ambiguous/binding failure/args
    // zod/the step's own `run` throw/the read-only declared-mutates
    // refusal) — each keeps its own branch, unchanged; this is only the
    // last net underneath all of them. `began` mirrors the exact point (marked
    // below, unchanged from before this task) this function already
    // treats as "a receipt is always written from here on": a throw
    // before it is "never began" (`receipt: null`, the same family as
    // undefined/ambiguous/the read-only declared-mutates refusal just
    // below), while a throw at or after it still gets a receipt written,
    // exactly like any other execution-phase failure this function
    // already handles inline.
    let began: {
      readonly receiptId: string;
      readonly receiptDir: string;
      readonly relativeReceiptDir: string;
      readonly stepName: string;
      readonly startedAt: Date;
      // This step's own declared `mutates` (typed) or `null` (compat) —
      // carried on `began` so the general backstop catch below (which has
      // no `entry` in scope of its own) can still put the right value on a
      // receipt it has to write (this task's spec, decision 3).
      readonly mutates: boolean | null;
      rawArgs: unknown;
    } | null = null;

    try {
      const outcome = matchPickleStep(pickleStep.text, bindings);

      if (outcome.kind === "undefined") {
        scenarioFailed = true;
        stepRecords.push({
          text: pickleStep.text,
          status: "undefined",
          receipt: null,
          error: { message: undefinedStepMessage(pickleStep.text) },
        });
        continue;
      }

      if (outcome.kind === "ambiguous") {
        scenarioFailed = true;
        stepRecords.push({
          text: pickleStep.text,
          status: "ambiguous",
          receipt: null,
          error: { message: ambiguousStepMessage(pickleStep.text, outcome.stepNames) },
        });
        continue;
      }

      const entry = vocabulary.get(outcome.stepName);
      if (!entry) {
        // Unreachable: `outcome.stepName` only ever comes from a binding built
        // from this same vocabulary (match-step.ts's buildStepBindings).
        continue;
      }

      if (entry.kind === "typed") {
        // Read-only policy, declared-mutates refusal (this task's spec,
        // decision 3): a "never began" outcome, alongside undefined/
        // ambiguous above — no receipt id or directory is created, and the
        // rest of the scenario is skipped, matching cli/do.ts's own
        // setup-phase refusal for the same policy. `mutates: false` steps
        // are unaffected regardless of policy — and, since
        // t2-trust-declaration, so is a step that goes on to actually write
        // despite that declaration: the declaration is trusted, not
        // re-verified against what execution measures, so
        // `finishExecutedStep` no longer has a backstop for it. A compat
        // entry has no declared `mutates` at all (m2b-compat-execution task
        // spec, item 2), so this check simply does not apply to one; nothing
        // in this file checks a compat step's read-only behavior either.
        if (policy === "read-only" && entry.step.mutates) {
          scenarioFailed = true;
          stepRecords.push({
            text: pickleStep.text,
            status: "failed",
            receipt: null,
            error: { message: readOnlyDeclaredMutatesMessage(outcome.stepName, environment) },
          });
          continue;
        }

        // --- This step's execution has begun: a receipt is always written
        // from here, whatever happens (mirrors cli/do.ts's own execution
        // phase). ---
        const receiptId = generateReceiptId();
        const relativeReceiptDir = path.join(config.stateDir, "receipts", receiptId);
        const receiptDir = path.join(rootDir, relativeReceiptDir);
        await mkdir(receiptDir, { recursive: true });
        contextHandle.beginStep(receiptDir);
        worldInstrumentation.beginStep();
        declaredCollector.beginStep(receiptDir);
        began = {
          receiptId,
          receiptDir,
          relativeReceiptDir,
          stepName: outcome.stepName,
          startedAt: new Date(),
          mutates: entry.step.mutates,
          rawArgs: undefined,
        };

        const bindResult = bindStepArgs(
          outcome.stepName,
          outcome.captures,
          outcome.values,
          pickleStep.argument,
          entry.step.args,
        );

        const stepStartedAt = new Date();
        let status: "ok" | "failed";
        let result: unknown;
        let errorMessage = "";
        let errorKind: ErrorKind | undefined;
        const rawArgs: unknown = bindResult.ok ? bindResult.value : bindResult.partialValue;
        began.rawArgs = rawArgs;

        if (!bindResult.ok) {
          status = "failed";
          errorMessage = bindResult.message;
          errorKind = "binding_invalid";
        } else {
          // `from` injection (this task's spec, item 4) — after binding, so
          // capture already won every key it could; before args validation,
          // so an injected key is validated exactly like a captured one and
          // a required key `from` couldn't fill still fails args validation
          // normally (the "last line of defense" this task's spec names —
          // m6b's own pre-execution guard is what turns this into a fatal
          // check *before* the browser session even starts).
          const stillMissingFrom = injectFrom(
            bindResult.value,
            entry.step,
            chain,
            stepNameOf,
            contextHandle.recordUsed,
          );
          const argsResult = entry.step.args.safeParse(bindResult.value);
          if (!argsResult.success) {
            status = "failed";
            errorMessage =
              `args validation failed: ${formatValidationIssues(argsResult.error.issues)}` +
              fromInjectionHint(argsResult.error.issues, stillMissingFrom);
            errorKind = "args_invalid";
          } else {
            try {
              const runResult = await entry.step.run(contextHandle.ctx, argsResult.data);
              const returnsResult = entry.step.returns.safeParse(runResult);
              if (!returnsResult.success) {
                status = "failed";
                errorMessage = `returns validation failed: ${formatValidationIssues(returnsResult.error.issues)}`;
                errorKind = "result_invalid";
              } else {
                status = "ok";
                result = returnsResult.data;
              }
            } catch (error) {
              // Always "step_error", never routed through
              // `classifyCaughtError` (this file's own header, m3a-receipt-
              // kinds task spec): a typed step's `run(ctx, args)` never
              // receives `this` and has no timeout mechanism, so neither a
              // `WorldWriteValidationError` nor a `CompatTimeoutError` can
              // ever reach this catch.
              status = "failed";
              errorMessage = error instanceof Error ? error.message : String(error);
              errorKind = "step_error";
            }
          }
        }

        await finishExecutedStep(
          pickleStep,
          { receiptId, receiptDir, relativeReceiptDir },
          stepStartedAt,
          outcome.stepName,
          status,
          errorMessage,
          errorKind,
          result,
          rawArgs,
          entry.step,
          entry.step.mutates,
        );
        await runAfterStepHooks(stepIndex, status);
      } else {
        // entry.kind === "compat" (m2b-compat-execution task spec, items
        // 2-3): fn is called with `this = World` and positional arguments —
        // no args/returns schema exists to validate against, so there is no
        // binding-failure branch here the way there is for a typed step.
        const receiptId = generateReceiptId();
        const relativeReceiptDir = path.join(config.stateDir, "receipts", receiptId);
        const receiptDir = path.join(rootDir, relativeReceiptDir);
        await mkdir(receiptDir, { recursive: true });
        contextHandle.beginStep(receiptDir);
        worldInstrumentation.beginStep();
        declaredCollector.beginStep(receiptDir);
        began = {
          receiptId,
          receiptDir,
          relativeReceiptDir,
          stepName: outcome.stepName,
          startedAt: new Date(),
          // Compat has no `mutates` declaration at all (this task's spec,
          // decision 3) — `null`, never coerced to `false`.
          mutates: null,
          rawArgs: undefined,
        };

        // Positional args: the matched values, then — when the pickle step
        // carries a table or docstring — one more argument (this task's
        // spec, item 3). The receipt's own `args` stays JSON-plain
        // (`string[][]`/`string`); the *function call* gets a richer
        // `DataTable` wrapping those same rows (2026-08-02 lead scope
        // addendum: a raw `string[][]` would break existing glue calling
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
        let status: "ok" | "failed" = "ok";
        let errorMessage = "";
        let errorKind: ErrorKind | undefined;
        // Item 5's arity check, before the call itself: a compat step's
        // glue function declaring more parameters than `positionalArgs`
        // actually supplies is cucumber-js's own signal for a `done`
        // callback — nukadoko never passes one (see `doneCallbackMessage`'s
        // own header for why calling it anyway would already be the
        // failure this closes).
        if (entry.compat.fn.length > positionalArgs.length) {
          status = "failed";
          errorMessage = doneCallbackMessage("Step", outcome.stepName);
          errorKind = "unsupported";
        } else {
          try {
            // Item 2: `entry.compat.timeoutMs` is this step's own
            // `{ timeout }` (wired through discover-steps.ts's
            // `CompatStepDefinition.timeoutMs`) — `undefined` runs
            // unbounded, same as before this task. m22-compat-run-scope task
            // spec, item 1: `?? defaultTimeoutMs` only ever takes effect when
            // this step declared no `{ timeout }` of its own.
            const returnValue = await runWithTimeout(
              () => Promise.resolve(entry.compat.fn.apply(world, positionalArgs)),
              entry.compat.timeoutMs ?? defaultTimeoutMs,
              "Step",
              outcome.stepName,
            );
            // Item 4: cucumber-js's own pending/skipped return convention —
            // nukadoko doesn't implement either, so this fails loudly
            // instead of quietly passing (see `pendingOrSkippedMessage`'s
            // own header).
            if (returnValue === "pending" || returnValue === "skipped") {
              status = "failed";
              errorMessage = pendingOrSkippedMessage("Step", outcome.stepName, returnValue);
              errorKind = "unsupported";
            }
          } catch (error) {
            // m3a-receipt-kinds task spec, decisions 1-2: identified by
            // type (`CompatTimeoutError`/`WorldWriteValidationError`), never
            // by matching `message` — see `classifyCaughtError`'s own header.
            status = "failed";
            errorMessage = error instanceof Error ? error.message : String(error);
            errorKind = classifyCaughtError(error);
          }
        }

        // `result: null` unconditionally on a non-throwing run (docs/
        // spec.md "Receipts": "Compat steps record result: null") — never
        // whatever `fn` itself happened to return, and no `chain` entry
        // (compat has no validated result to make citable via
        // `ctx.resultOf`, and no Step object to key one on).
        await finishExecutedStep(
          pickleStep,
          { receiptId, receiptDir, relativeReceiptDir },
          stepStartedAt,
          outcome.stepName,
          status,
          errorMessage,
          errorKind,
          null,
          rawArgsList,
          undefined,
          null,
        );
        await runAfterStepHooks(stepIndex, status);
      }
    } catch (error) {
      // The backstop itself (see the comment above `began`): anything that
      // threw without ever being turned into a `status`/`errorMessage` pair
      // above lands here. `began` says whether this step's own receipt phase
      // had started by then, so the same "never began" vs "always gets a
      // receipt" boundary this function already draws elsewhere still holds.
      scenarioFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      if (began === null) {
        stepRecords.push({
          text: pickleStep.text,
          status: "failed",
          receipt: null,
          error: { message },
        });
      } else {
        const stepFinishedAt = new Date();
        const httpLogExists = existsSync(path.join(began.receiptDir, "http.jsonl"));
        const observed = contextHandle.observedCounts();
        const usedEntries = contextHandle.usedSnapshot();
        // Same backstop-only read as `observed`/`used` just above (t3-
        // sections task spec, decision 4) — whatever labels this step
        // reached before the uncaught throw still belong on its receipt.
        const sectionLabels = contextHandle.sectionsSnapshot();
        // Same backstop-only read again, for `polls` (ctx-poll-receipt task
        // spec) — a poll this step was mid-wait on when the uncaught throw
        // hit still finished (`finally` in poll.ts's own loop guarantees
        // that), so its own record still belongs on this receipt.
        const pollRecords = contextHandle.pollsSnapshot();
        // Same backstop-only read again, for `required_env` (env-reads-and-
        // mutates-doc task spec, item A) — whatever names this step
        // required before the uncaught throw still belong on its receipt.
        const requiredEnv = contextHandle.envReadsSnapshot();
        const worldReadsWrites = worldInstrumentation.snapshot();
        const declared = declaredCollector.snapshot();
        const receipt: Receipt = {
          receipt_id: began.receiptId,
          step: began.stepName,
          kind: "run",
          args: began.rawArgs,
          // This is the true catch-all: whatever threw here was never
          // turned into an `ErrorKind` by any of the classification points
          // above, so this is the default-to-step_error-when-uncertain case
          // itself, not just its fallback (this task's spec, decision 1).
          error: { message, kind: "step_error" },
          status: "failed",
          environment,
          target_version: targetVersion,
          session,
          scenario: scenarioId,
          started_at: began.startedAt.toISOString(),
          finished_at: stepFinishedAt.toISOString(),
          evidence: {
            dir: began.relativeReceiptDir,
            screenshots: [],
            ...(httpLogExists ? { http: "http.jsonl" } : {}),
          },
          observed,
          mutates: began.mutates,
          ...(usedEntries.length > 0 ? { used: usedEntries } : {}),
          ...(sectionLabels.length > 0 ? { sections: sectionLabels } : {}),
          ...(pollRecords.length > 0 ? { polls: pollRecords } : {}),
          ...(requiredEnv.length > 0 ? { required_env: requiredEnv } : {}),
          ...(worldReadsWrites.reads.length > 0 || worldReadsWrites.writes.length > 0
            ? { world: worldReadsWrites }
            : {}),
          ...(declared ? { declared } : {}),
        };
        const redactedReceipt = redact(receipt, secrets) as Receipt;
        await writeReceipt(began.receiptDir, redactedReceipt);
        stepRecords.push({
          text: pickleStep.text,
          status: "failed",
          receipt: began.receiptId,
          error: { message },
        });
        // `began !== null`: this step's own execution had already begun (a
        // receipt was written above) before the uncaught throw this backstop
        // exists for — so, unlike the `began === null` arm just above (never
        // began at all), this step did execute, and AfterStep runs after it
        // exactly like the typed/compat branches' own calls further up.
        await runAfterStepHooks(stepIndex, "failed");
      }
    }
  }

  // After hooks are attempted regardless of Before/step outcome (this
  // task's spec, item 5), before dispose() so a hook can still use
  // `this.page`/`this.request` while the browser/request context is open —
  // redirected to the scenario's own boundary for the same reason Before
  // hooks are, above, rather than left pointed at whichever step happened
  // to run last.
  contextHandle.beginStep(scenarioDir);
  worldInstrumentation.beginStep();
  for (const hook of afterHooks) {
    // Same per-hook declared boundary as the Before loop above (this task's
    // spec, item 4) — reset right before, read right after, so one After
    // hook's own declared data never bleeds into a sibling's.
    declaredCollector.beginStep(scenarioDir);
    // Item 3: `result.status` reflects the scenario's outcome *as of right
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
    );
    // Same non-throwing arity/pending-skipped classification as the Before
    // loop above (this task's spec, decision 2) — see that loop's own
    // comment for why.
    let hookStatus: "ok" | "failed" = "ok";
    let hookErrorMessage = "";
    let hookErrorKind: ErrorKind = "step_error";
    if (hook.fn.length >= 2) {
      hookStatus = "failed";
      hookErrorMessage = doneCallbackMessage("Hook", "After");
      hookErrorKind = "unsupported";
    } else {
      try {
        const returnValue = await runWithTimeout(
          () => Promise.resolve(hook.fn.call(world, hookParameter)),
          hook.timeoutMs ?? defaultTimeoutMs,
          "Hook",
          "After",
        );
        if (returnValue === "pending" || returnValue === "skipped") {
          hookStatus = "failed";
          hookErrorMessage = pendingOrSkippedMessage("Hook", "After", returnValue);
          hookErrorKind = "unsupported";
        }
      } catch (error) {
        hookStatus = "failed";
        hookErrorMessage = error instanceof Error ? error.message : String(error);
        hookErrorKind = classifyCaughtError(error);
      }
    }
    const declared = declaredCollector.snapshot();
    if (hookStatus === "ok") {
      hookRecords.push({ type: "after", status: "ok", ...(declared ? { declared } : {}) });
    } else {
      hookRecords.push({
        type: "after",
        status: "failed",
        error: { message: hookErrorMessage, kind: hookErrorKind },
        ...(declared ? { declared } : {}),
      });
      scenarioFailed = true;
    }
  }

  const finishedAt = new Date();

  let disposeResult;
  try {
    // No status argument (fb4-evidence-time task spec, item 1) — `dispose`'s
    // own evidence no longer varies by outcome, so there is nothing left for
    // this scenario's `scenarioFailed`/pass-fail status to select between.
    disposeResult = await contextHandle.dispose();
  } catch {
    // Same backstop as cli/do.ts: teardown failures must never take the
    // scenario record down with them.
    disposeResult = { evidence: { screenshots: [] }, storageState: undefined };
  }
  const { evidence: browserEvidence, storageState: storageStateToPersist } = disposeResult;

  if (sessionFilePath !== null && storageStateToPersist !== undefined) {
    try {
      await writeSessionFile(sessionFilePath, storageStateToPersist);
    } catch {
      // Persisting the session must not cost the scenario record, mirroring
      // cli/do.ts's own fault tolerance.
    }
  }

  const record: ScenarioRecord = {
    scenario_id: scenarioId,
    run_id: runId,
    feature: relativeFeaturePath,
    scenario: pickle.name,
    line: pickle.location?.line ?? 0,
    status: scenarioFailed ? "failed" : "passed",
    environment,
    ...(targetVersion !== undefined ? { target_version: targetVersion } : {}),
    session,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    steps: stepRecords,
    hooks: hookRecords,
    ...(git !== undefined ? { git } : {}),
    evidence: {
      dir: relativeScenarioDir,
      screenshots: browserEvidence.screenshots,
      ...(browserEvidence.trace !== undefined ? { trace: browserEvidence.trace } : {}),
    },
  };

  const redactedRecord = redact(record, secrets) as ScenarioRecord;
  await writeScenarioRecord(scenarioDir, redactedRecord);
  // This pickle is done — repoint "the currently active declared collector"
  // to nothing, so a stray facade call between this pickle and the next
  // (there shouldn't be one, but this mirrors `used`/`observed`'s own "never
  // let a boundary bleed into unrelated code" discipline) can't silently
  // land on an already-read collector instead of being dropped.
  setActiveDeclaredCollector(undefined);
  return redactedRecord;
}
