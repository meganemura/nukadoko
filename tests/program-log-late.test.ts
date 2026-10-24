import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the lines of the program's log that carry a step's trace
// id and arrive after the step ended, against
// tests/fixtures/late-log-project, whose program tags its lines with the
// trace id and a span id of its own: such a line stays the step's, never
// the next step's, the world's stop writes it to the step's
// program-log-late.txt, run.json and the summary name it once under that
// step, and a program whose lines all come late is told apart from one
// that tags none.

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

interface RunStepFacts {
  readonly text: string;
  readonly record: string;
  readonly observed: { readonly program_log: { readonly trace_id: string; readonly lines: number; readonly file: string | null } };
  readonly program_log_late?: { readonly lines: number; readonly file: string | null };
}

function linesIn(runDir: string, step: RunStepFacts, file: string | null | undefined): string[] {
  if (file === null || file === undefined) return [];
  return readFileSync(path.join(runDir, step.record, file), "utf8").trimEnd().split("\n");
}

describe("lines of the program's log after their step", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("late-log-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("keeps a late line with the step whose trace id it carries, writes it to that step's late file, and names it once", async () => {
    const { exitCode } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(0);
    const runDir = latestRunDir(rootDir);
    const run = latestRunJson(rootDir);
    const [waits, fast] = run.scenarios as { steps: RunStepFacts[] }[];
    for (const scenario of [waits!, fast!]) {
      const slow = scenario.steps[0]!;
      const id = slow.observed.program_log.trace_id;
      // The slice holds the line written before the step ended; the line
      // written 400 ms after the answer is in the late file.
      expect(linesIn(runDir, slow, slow.observed.program_log.file)).toEqual([expect.stringMatching(new RegExp(`^trace_id=${id} span_id=[0-9a-f]{16} started GET /slow$`))]);
      expect(slow.program_log_late).toEqual({ lines: 1, file: "program-log-late.txt" });
      expect(linesIn(runDir, slow, slow.program_log_late?.file)).toEqual([expect.stringMatching(new RegExp(`^trace_id=${id} span_id=[0-9a-f]{16} completed /slow$`))]);
      expect(scenario.steps[1]!.program_log_late).toBeUndefined();
    }
    // The next step's slice has none of the slow request's lines, whether
    // it sent a request of its own or nothing at all.
    const fastStep = fast!.steps[1]!;
    expect(linesIn(runDir, fastStep, fastStep.observed.program_log.file).map((line) => line.replace(/^trace_id=\S+ span_id=\S+ /, ""))).toEqual([
      "started GET /fast",
      "completed /fast",
    ]);
    expect(waits!.steps[1]!.observed.program_log).toEqual({ trace_id: expect.any(String), lines: 0, file: null, stamped: 0 });
    expect(run.worlds[0].program_log).toEqual({ stamped: 3, lines: 4, late: 2, tagged: 6 });

    const summary = readFileSync(path.join(runDir, "summary.md"), "utf8");
    const named = summary.split("\n").filter((line) => line.includes("program-log-late.txt"));
    expect(named).toEqual([
      "A line of the program's log that carries a step's trace id and arrived after its record was written is in that step's `program-log-late.txt`, and not in its record.",
      `- \`features/late.feature:4\` the step calls the slow path: 1 line of the program's log after the step ended, in \`program-log-late.txt\`; record \`${waits!.steps[0]!.record}\``,
      `- \`features/late.feature:8\` the step calls the slow path: 1 line of the program's log after the step ended, in \`program-log-late.txt\`; record \`${fast!.steps[0]!.record}\``,
    ]);
    expect(summary).not.toContain("program log of world");
  });

  it("does not rewrite the step record for a late line", async () => {
    await cli(rootDir, ["run"]);
    const run = latestRunJson(rootDir);
    const slow = (run.scenarios[0].steps as RunStepFacts[])[0]!;
    const record = JSON.parse(readFileSync(path.join(latestRunDir(rootDir), slow.record, "record.json"), "utf8")) as RunStepFacts;
    expect(record.observed.program_log.lines).toBe(1);
    expect(record.program_log_late).toBeUndefined();
  });

  // nuka do stops the world right after its one step, so the late line
  // here is one the program held until it was told to stop.
  it.runIf(process.platform !== "win32")("nuka do names a late line on stderr, beside the record it writes", async () => {
    const { exitCode, stdout, stderr } = await cli(rootDir, ["do", "call-slow", "--env", "buffered", "--args", "{}"]);

    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout) as { step_record_id: string; observed: RunStepFacts["observed"] };
    expect(record.observed.program_log.lines).toBe(0);
    const late = path.join(".nukadoko", "do", record.step_record_id, "program-log-late.txt");
    expect(stderr).toContain(
      `note\tprogram-log-late\t-\tworld buffered: 1 line(s) of the program's log carry the step's trace id and arrived after the step ended; see ${late}`,
    );
    expect(readFileSync(path.join(rootDir, late), "utf8")).toMatch(/started GET \/slow\n$/);
  });

  // A buffered program writes its lines when it is told to stop, which
  // Windows does by ending the process at once (taskkill /f).
  it.runIf(process.platform !== "win32")("says the lines came after the steps ended, and why that usually is, for a program that buffers them", async () => {
    const { exitCode } = await cli(rootDir, ["run", "--env", "buffered"]);

    expect(exitCode).toBe(0);
    const run = latestRunJson(rootDir);
    expect(run.worlds[0].program_log).toEqual({ stamped: 3, lines: 0, late: 6, tagged: 6 });
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary.split("\n").filter((line) => line.includes("program log of world"))).toEqual([
      "- program log of world buffered: its lines for the steps arrived after the steps ended, so each step's slice of it is empty " +
        "and the lines are in each step's `program-log-late.txt`. The usual cause is output buffered on a pipe: " +
        "set `STDOUT.sync = true` in Ruby, or `PYTHONUNBUFFERED=1` for Python.",
    ]);
    expect(summary).not.toContain("carries no trace ids");
    const slow = (run.scenarios[0].steps as RunStepFacts[])[0]!;
    expect(existsSync(path.join(latestRunDir(rootDir), slow.record, "program-log-late.txt"))).toBe(true);
  });
});
