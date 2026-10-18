import type { Finding } from "../finding/finding.js";
import type { RunProbe, RunScenario } from "../record/run-result.js";
import type { ProbeValue } from "../record/scenario-record.js";
import { runCodeInfo } from "../finding/run-codes.js";
import { shellWord } from "../shell/shell-word.js";
import type { RunConditions } from "./progress-log.js";

// Responsibility: the pure half of `nuka run --probe`. Which value a
// capture is changed to, and which note a probe that still passed, or did
// not measure, becomes.
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

/** One note for each probe that passed, and one for each probe that did
 * not measure, in a scenario that passed. A probe the Then caught is the
 * Then doing its job. Under `--repeat`, the executions of one scenario in
 * one environment fold into one note per step and key, the way verdicts
 * fold, and a note that held in only some of them says in how many. */
export function probeFindings(scenarios: readonly RunScenario[], conditions: RunConditions): Finding[] {
  const cellKey = (scenario: RunScenario): string => JSON.stringify([scenario.feature, scenario.line, scenario.environment]);
  const executions = new Map<string, number>();
  for (const scenario of scenarios) executions.set(cellKey(scenario), (executions.get(cellKey(scenario)) ?? 0) + 1);
  const groups = new Map<string, { scenario: RunScenario; probe: RunProbe; code: ProbeNoteCode; count: number }>();
  for (const scenario of scenarios) {
    if (scenario.status !== "passed") continue;
    for (const probe of scenario.probes ?? []) {
      const code = probe.status === "passed" ? "then-passed-with-changed-capture" : probe.status === "not-measured" ? "then-probe-not-measured" : null;
      if (code === null) continue;
      const key = JSON.stringify([cellKey(scenario), probe.line, probe.step, probe.key, code]);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { scenario, probe, code, count: 1 });
      else group.count += 1;
    }
  }
  return [...groups.values()].map(({ scenario, probe, code, count }): Finding => {
    const info = runCodeInfo(code);
    const total = executions.get(cellKey(scenario)) ?? 1;
    const env = conditions.named ? ` (${scenario.environment})` : "";
    const what =
      code === "then-passed-with-changed-capture"
        ? `passed with ${probe.key} ${shown(probe.changed)} in place of ${shown(probe.recorded)}`
        : `was not probed with ${probe.key} ${shown(probe.changed)} (${probe.reason}): ${probe.message}`;
    return {
      severity: info.severity,
      code,
      file: scenario.feature,
      ...(probe.line === null ? {} : { line: probe.line }),
      step: probe.step,
      message: `${probe.text}: step "${probe.step}"${env} ${what}${count < total ? `, in ${count} of ${total} executions` : ""}`,
      fix: info.fix,
      do: ["nuka", "run", `${scenario.feature}:${scenario.line}`, "--probe", ...conditions.rerunFlags(scenario.environment)].map(shellWord).join(" "),
    };
  });
}

type ProbeNoteCode = "then-passed-with-changed-capture" | "then-probe-not-measured";
