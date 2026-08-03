import { AfterAll, BeforeAll } from "../../nukadoko-compat-shim.js";

// Same globalThis capture convention as ../../compat-run-all-hooks-project/
// features/support/run-hooks.ts — see that file's own header for why.
function record(label: string): void {
  const g = globalThis as Record<string, unknown>;
  const log = (g.__nukadokoRunAllHooksTimeoutLog as string[] | undefined) ?? [];
  log.push(label);
  g.__nukadokoRunAllHooksTimeoutLog = log;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Registered first: outlives its own 20ms timeout (m22-compat-run-scope
// task spec, item 2: BeforeAll({ timeout }, fn)'s own timeout takes
// effect), recording its own start before the sleep that outlives it.
BeforeAll({ timeout: 20 }, async function () {
  record("beforeAll-first");
  await sleep(500);
});

// Registered second: must never run at all (this task's spec: the first
// failure aborts the rest) — the log below must not contain
// "beforeAll-second".
BeforeAll(function () {
  record("beforeAll-second");
});

// Must still be attempted despite BeforeAll's own failure (this task's
// spec: AfterAll is still attempted even so).
AfterAll(function () {
  record("afterAll");
});
