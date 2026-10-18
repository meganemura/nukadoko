import type { Finding } from "../finding/finding.js";
import type { RunScenario } from "../record/run-result.js";
import type { ProbeValue } from "../record/scenario-record.js";
import { runCodeInfo } from "../finding/run-codes.js";
import { shellWord } from "../shell/shell-word.js";

// Responsibility: the pure half of `nuka run --probe`. Which value a
// capture is changed to, and which note a probe that still passed becomes.
// Boundary: no I/O and no step execution; src/run/run-scenario.ts re-runs
// the Then and records each probe on the scenario record.
//
// A probe asks whether a Then could have failed: the same step, the same
// ctx, the same args, with one value its sentence names changed. A changed
// value must stay the type the step's args schema already accepted, so the
// re-run reaches the step's own comparison instead of failing args
// validation, which would say nothing about the step.

/** What a changed string ends with. */
export const PROBE_SUFFIX = "-probe";

/** The value a probe runs a capture with, or `null` when the capture is
 * not probed: a value of another type, or a number +1 leaves the same
 * (not finite, or past 2^53). */
export function mutateCapture(value: unknown): { readonly value: ProbeValue } | null {
  if (typeof value === "string") return { value: `${value}${PROBE_SUFFIX}` };
  if (typeof value === "boolean") return { value: !value };
  if (typeof value === "number") {
    const next = value + 1;
    return Object.is(next, value) ? null : { value: next };
  }
  return null;
}

function shown(value: ProbeValue): string {
  return JSON.stringify(value);
}

/** One note for each probe that passed in a scenario that passed. A probe
 * that failed is the Then doing its job. */
export function probeFindings(scenarios: readonly RunScenario[], rerunFlags: readonly string[]): Finding[] {
  const info = runCodeInfo("then-passed-with-changed-capture");
  return scenarios.flatMap((scenario) =>
    scenario.status !== "passed"
      ? []
      : (scenario.probes ?? []).flatMap((probe): Finding[] =>
          probe.status !== "passed"
            ? []
            : [
                {
                  severity: info.severity,
                  code: "then-passed-with-changed-capture",
                  file: scenario.feature,
                  ...(probe.line === null ? {} : { line: probe.line }),
                  step: probe.step,
                  message: `step "${probe.step}" passed with ${probe.key} ${shown(probe.changed)} in place of ${shown(probe.recorded)}`,
                  fix: info.fix,
                  do: ["nuka", "run", `${scenario.feature}:${scenario.line}`, "--probe", ...rerunFlags].map(shellWord).join(" "),
                },
              ],
        ),
  );
}
