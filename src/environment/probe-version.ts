// Responsibility: run an environment's `version` probe with a hard timeout,
// per docs/spec.md "Sessions, environments, secrets" (`target_version`
// recorded "(when probed)") and this task's spec, decision 5 — called once,
// by the executor (cli/do.ts), at the top of the execution phase, never
// reachable from a step's own `run`. A probe is metadata about the target,
// not part of what the step is being measured doing: neither a throw nor a
// timeout may fail the run itself, so this module never throws — it always
// resolves to a result the caller decides how to report (omit
// `target_version`, write one stderr warning line).
//
// The 10s budget is enforced with `Promise.race` against a `setTimeout`
// rather than `AbortController`: `version` is an arbitrary user function
// (docs/spec.md: URL+jsonPath duplication was rejected in favor of "just
// write TS"), so there is no request object here to hand an `AbortSignal`
// to. Racing only stops *waiting* for a hung probe; it cannot cancel
// whatever the probe itself started, which is an accepted limitation of not
// controlling the probe's implementation.

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export type VersionProbeResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Runs `probe` (an environment's `version` function) with a `timeoutMs`
 * budget. Returns `undefined` when there is no probe configured at all —
 * distinct from `{ ok: false }`, which means a probe *was* configured but
 * threw, rejected, timed out, or returned something other than a string.
 */
export async function probeVersion(
  probe: (() => string | Promise<string>) | undefined,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<VersionProbeResult | undefined> {
  if (!probe) {
    return undefined;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`version probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    // Wrapping the call in `Promise.resolve().then(probe)` means a probe
    // that throws *synchronously* rejects the same way one that returns a
    // rejecting promise does, so both are caught by the single catch below.
    const result = await Promise.race([Promise.resolve().then(() => probe()), timeout]);
    if (typeof result !== "string") {
      return {
        ok: false,
        reason: `version probe must resolve to a string, got ${typeof result}`,
      };
    }
    return { ok: true, version: result };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    // Otherwise a probe that resolved well within its budget would still
    // leave a 10s timer pending, needlessly holding the event loop open.
    clearTimeout(timeoutHandle);
  }
}
