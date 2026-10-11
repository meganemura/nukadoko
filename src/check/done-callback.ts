// Responsibility: the done() arity rule shared by `nuka check` and the
// executor. cucumber-js treats a glue function as callback-style when it
// declares more parameters than the caller passes, and then supplies a
// callback nukadoko never has. Calling that function would already be the
// failure: the callback never fires, the function returns having done none
// of its real work, and that work keeps running after the step or hook is
// recorded. The comparison here is the whole rule. Scenario hooks (Before,
// After, AfterStep) are passed one HookParameter. Run-scope hooks
// (BeforeAll, AfterAll) are passed none. A compat step is passed one
// argument per matched capture, plus one more when the line carries a
// table or docstring.
//
// A "pending" or "skipped" return is not decided here. That value exists
// only after the function runs, so it stays a `nuka run` failure.
//
// `doneCallbackMessage` lives beside the comparison so the check finding
// and the run failure are one sentence. src/run/run-scenario.ts re-exports
// it for the BeforeAll/AfterAll paths in src/cli/run.ts and
// src/run/run-worker-entry.ts.

export const SCENARIO_HOOK_ARG_COUNT = 1;

export const RUN_HOOK_ARG_COUNT = 0;

/** True when `declaredLength` is cucumber-js's signal for a done() callback
 * under a caller that passes `passedArgCount` arguments. */
export function declaresDoneCallback(declaredLength: number, passedArgCount: number): boolean {
  return declaredLength > passedArgCount;
}

/** Arguments a matched compat step is called with: one per capture, and one
 * more when the line has a table or a docstring. Gherkin gives a step at
 * most one of those attachments. */
export function passedArgCountForStep(captureCount: number, hasTableOrDocstring: boolean): number {
  return captureCount + (hasTableOrDocstring ? 1 : 0);
}

export function doneCallbackMessage(kind: "Step" | "Hook", name: string): string {
  return (
    `${kind} "${name}" appears to expect a done() callback (it declares more parameters ` +
    `than nukadoko passes it). nukadoko has no callback form; rewrite it to return a ` +
    `Promise (async/await). See docs/migration.md`
  );
}
