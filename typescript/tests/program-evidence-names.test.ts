import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a step's evidence cannot take the name of a file or
// directory nukadoko writes beside the step record when it serves the
// program, against tests/fixtures/late-log-project: the step's lines of
// the program's log (program-log.txt, program-log-late.txt) and, under
// nuka do, the world's directory (world). Each is refused at the call,
// so the program's lines never replace what the step attached, and what
// the step attached never replaces them.

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

interface DoRecord {
  readonly step_record_id: string;
  readonly status: string;
  readonly error?: { readonly name?: string; readonly message: string };
  readonly observed: { readonly program_log: { readonly lines: number; readonly file: string | null } };
}

describe("evidence names beside a world", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("late-log-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it.each(["program-log.txt", "Program-Log-Late.txt", "world"])("refuses a step's evidence named %s under nuka do", async (name) => {
    const { exitCode, stdout } = await cli(rootDir, ["do", "attach-named", "--args", JSON.stringify({ name })]);

    expect(exitCode).toBe(1);
    const record = JSON.parse(stdout) as DoRecord;
    expect(record.status).toBe("failed");
    expect(record.error?.message).toContain(`ctx.evidence name ${JSON.stringify(name)} is reserved`);
  });

  it("keeps the step's attachment and the program's lines apart under another name", async () => {
    const { exitCode, stdout } = await cli(rootDir, ["do", "attach-named", "--args", JSON.stringify({ name: "notes.txt" })]);

    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout) as DoRecord;
    const dir = path.join(rootDir, ".nukadoko", "do", record.step_record_id);
    expect(readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("the step's own evidence\n");
    expect(record.observed.program_log).toMatchObject({ lines: 2, file: "program-log.txt" });
    expect(readFileSync(path.join(dir, "program-log.txt"), "utf8")).toMatch(/started GET \/fast\n.*completed \/fast\n$/);
  });
});
