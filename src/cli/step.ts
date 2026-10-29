import { loadConfig } from "../config/load-config.js";
import { formatFinding, type Finding } from "../finding/finding.js";
import { runStepCall, type StepCall, type StepCallResult, type WalkFound } from "../run/walk-files.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { REFUSED_EXIT_CODE, RefusalError, formatEnvelope, refusalOf, refuse, withHint } from "./refusal.js";

// Responsibility: `nuka step wait`, `nuka step next <pause>`, and `nuka
// step stop <pause>`, the side of a walk that answers it. Boundary: this
// module reads its arguments, finds the state directory, and prints.
// walk-files.ts reads and writes the walk's files, and walk.ts decides what
// a call does; no answer is written from here.

export type StepAction = "wait" | "next" | "stop";

export interface RunStepOptions {
  readonly rootDir: string;
  readonly action: StepAction;
  /** The pause an answer names, as the command line gave it. */
  readonly pause?: number;
  /** `--timeout`, in seconds. */
  readonly timeout: number;
  readonly json: boolean;
  readonly notices?: readonly Finding[];
  readonly stdout: WritableSink;
  readonly stderr: WritableSink;
}

function joined(runDir: string, relative: string): string {
  return `${runDir}/${relative.split("\\").join("/")}`;
}

// What a person reads at a pause: where the step is, what it recorded, the
// views of the pages it left open, and the two answers.
function walkText(seen: WalkFound, fields: Readonly<Record<string, unknown>>): string {
  if (seen.state === "gone") {
    return `walk ${seen.last.number} is gone: its nuka run --step process (pid ${seen.last.pid}) ended without recording how\n`;
  }
  if (seen.state === "paused") {
    const { pause, run_dir: runDir, scenario, world } = seen;
    const lines = [
      `walk ${seen.number} paused after step ${pause.pause}/${pause.of} (${pause.status}): ${pause.text}`,
      `  scenario: ${scenario.feature}:${scenario.line} ${scenario.name} (${scenario.environment})`,
      ...(pause.error === undefined ? [] : [`  error: ${pause.error.message.split("\n")[0] ?? ""}`]),
      `  record: ${joined(runDir, pause.record)}/record.json`,
      ...pause.views.map((view) => {
        const files = [view.screenshot, view.aria].flatMap((file) => (file === null ? [] : [joined(runDir, file)]));
        const name = view.as === null ? `page ${view.page}` : `page ${view.page} of ${view.as}`;
        return `  view: ${name} ${view.url} ${JSON.stringify(view.title)}${files.length === 0 ? " (no capture)" : `: ${files.join(" ")}`}`;
      }),
      ...(world === null ? [] : [`  world: ${world.url}`]),
      `  do: nuka step next ${pause.pause}${pause.remaining > 0 ? `   (or: nuka step stop ${pause.pause})` : ""}`,
    ];
    return `${lines.join("\n")}\n`;
  }
  if (seen.state === "ended") {
    const { end } = seen;
    const head =
      end.how === "interrupted"
        ? `walk ${seen.number} ended: interrupted by ${end.signal}, exit ${end.exit_code}`
        : end.how === "not-run"
          ? `walk ${seen.number} ended before its scenario ran, exit ${end.exit_code}`
          : end.stopped !== undefined
            ? `walk ${seen.number} ended: stopped after step ${end.stopped.after_step}${end.stopped.line === null ? "" : ` (line ${end.stopped.line})`}, exit ${end.exit_code}`
            : `walk ${seen.number} ended: the run finished, exit ${end.exit_code}`;
    const run = end.how === "finished" && seen.run_dir !== undefined ? [`  run: ${seen.run_dir}/run.json`] : [];
    return `${[head, ...run].join("\n")}\n`;
  }
  const after = seen.state === "running" ? seen.after : 0;
  return `walk ${seen.number} is running ${after === 0 ? "its first step" : `the step after pause ${after}`}\n  do: ${String(fields["do"])}\n`;
}

function callOf(options: RunStepOptions): StepCall | { readonly refused: string } {
  if (options.action === "wait") return { kind: "wait" };
  const { pause } = options;
  if (pause === undefined || !Number.isInteger(pause) || pause < 1) {
    return { refused: `nuka step ${options.action} needs the number of the pause it answers, a whole number of 1 or more${pause === undefined ? "" : ` (got ${pause})`}` };
  }
  return { kind: "answer", pause, answer: options.action };
}

export async function runStep(options: RunStepOptions): Promise<number> {
  const { rootDir, json, stdout, stderr } = options;
  const notices = options.notices ?? [];
  const command = `step ${options.action}`;
  const sinks = { json, stdout, stderr, command };
  const call = callOf(options);
  if ("refused" in call) return refuse(sinks, call.refused, "invalid-value", { do: "nuka step wait" }, notices);
  if (!Number.isFinite(options.timeout) || options.timeout < 0) {
    return refuse(sinks, `--timeout must be a number of seconds, 0 or more (got ${options.timeout}).`, "invalid-value", undefined, notices);
  }
  let stateDir: string;
  try {
    stateDir = (await loadConfig(rootDir)).stateDir;
  } catch (error) {
    return refuse(sinks, error, "unexpected-error", undefined, notices);
  }
  let result: StepCallResult;
  try {
    result = await runStepCall({ rootDir, stateDir, call, timeoutMs: options.timeout * 1000 });
  } catch (error) {
    return refuse(sinks, error, "unexpected-error", undefined, notices);
  }
  if (result.kind === "refuse") {
    const hint = result.do === undefined ? {} : { do: result.do };
    const findings = [...notices, refusalOf(new RefusalError(result.code, result.message, hint), result.code, command)];
    if (json) stdout.write(formatEnvelope(command, REFUSED_EXIT_CODE, findings, result.fields ?? {}));
    else for (const finding of findings) stderr.write(formatFinding(withHint(finding)));
    return REFUSED_EXIT_CODE;
  }
  const { report, seen } = result;
  const findings = [...notices, ...report.findings];
  if (json) {
    stdout.write(formatEnvelope(command, report.exitCode, findings, report.fields));
  } else {
    stdout.write(walkText(seen, report.fields));
    for (const finding of findings) stderr.write(formatFinding(withHint(finding)));
  }
  return report.exitCode;
}
