import { AfterAll, BeforeAll } from "../../nukadoko-compat-shim.js";

// Same globalThis capture convention as ../../compat-run-all-hooks-project/
// features/support/run-hooks.ts — see that file's own header for why.
function record(label: string): void {
  const g = globalThis as Record<string, unknown>;
  const log = (g.__nukadokoRunAllHooksTimeoutLog as string[] | undefined) ?? [];
  log.push(label);
  g.__nukadokoRunAllHooksTimeoutLog = log;
}

// Settles only when tests/compat-run-scope.test.ts releases it, after the
// run has returned. A run that waited for this hook instead of cutting it
// off at its timeout would never return, however fast or slow the machine.
function heldUntilReleased(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const held = (g.__nukadokoHeldSteps as Array<() => void> | undefined) ?? [];
  g.__nukadokoHeldSteps = held;
  return new Promise((resolve) => held.push(resolve));
}

// Registered first: only its own 20ms timeout (BeforeAll({ timeout }, fn)'s
// own timeout takes effect) can end it. It records its start first.
BeforeAll({ timeout: 20 }, async function () {
  record("beforeAll-first");
  await heldUntilReleased();
});

// Registered second: must never run at all (the first
// failure aborts the rest) — the log below must not contain
// "beforeAll-second".
BeforeAll(function () {
  record("beforeAll-second");
});

// Must still be attempted despite BeforeAll's own failure.
AfterAll(function () {
  record("afterAll");
});
