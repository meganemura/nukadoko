import { describeCounted, type CountedGroup } from "../execution-events/counted.js";
import type { Finding } from "../finding/finding.js";
import { runCodeInfo } from "../finding/run-codes.js";
import type { RunScenario } from "../record/run-result.js";
import { scenarioLabel, type RunConditions } from "./progress-log.js";

// Responsibility: the `undeclared-write` note of a finished run: a step
// that declares `mutates: false` whose trace holds a write the program
// committed to a table that holds state. The declaration says the step
// changes nothing a later step reads; the program's execution events say
// it did. Pure. Boundary: which writes persisted, and which tables hold
// state, are the world's stop's (src/context/events-file.ts, under the
// world's tables list); the declaration is the step record's `mutates`.
//
// Declaration and measurement answer different questions, so neither
// overrules the other: the note names the step, the table, and the op,
// and the person decides which is wrong. It claims only what can end one
// way: a write the lines say persisted, on a table the tables list does
// not mark as bookkeeping or infrastructure. A write that rolled back, one
// whose commit state no line decides, and one on a table nukadoko cannot
// place (a tables list that was not read, a table the writer could not
// name) are not named, and an HTTP method is never read as a write.
//
// Only head's executions are noted: a base or old world runs another
// tree's steps, whose declarations are not the change under review.

/** One `undeclared-write` note per step line of each scenario and
 * environment that wrote, the first execution's writes named, since the
 * runs of `--repeat` would say it again. `writesOf` gives a step's
 * persisted writes to state by its events trace id. Pure. */
export function undeclaredWriteFindings(
  scenarios: readonly RunScenario[],
  writesOf: (traceId: string) => readonly CountedGroup[] | undefined,
  conditions: Pick<RunConditions, "named">,
): Finding[] {
  const info = runCodeInfo("undeclared-write");
  const findings = new Map<string, Finding>();
  for (const scenario of scenarios) {
    if (scenario.world !== undefined) continue;
    scenario.steps.forEach((step, index) => {
      if (step.mutates !== false) return;
      const traceId = step.observed?.events?.trace_id;
      const writes = traceId === undefined ? undefined : writesOf(traceId);
      if (writes === undefined || writes.length === 0) return;
      const line = step.line ?? scenario.line;
      const key = `${scenario.feature}:${scenario.line}:${scenario.environment}:${index}`;
      if (findings.has(key)) return;
      findings.set(key, {
        severity: info.severity,
        code: "undeclared-write",
        file: scenario.feature,
        line,
        message:
          `${scenarioLabel(scenario.scenario, scenario.environment, conditions)}: the step at line ${line}, ${step.step ?? step.text}, declares mutates: false, ` +
          `and its trace holds writes the program committed to tables that hold state, ${describeCounted(writes)}`,
        fix: info.fix,
      });
    });
  }
  return [...findings.values()];
}
