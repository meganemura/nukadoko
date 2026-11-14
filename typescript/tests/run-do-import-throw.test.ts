import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { discoverSteps } from "../src/discover/discover-steps.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: a step file that throws while it is imported is named by
// the commands that stop at the first such file. `nuka check` and `nuka
// steps` already name it. `nuka run` and `nuka do` print only
// the thrown error's message, and a top-level property read's message
// does not include the file.

const rootDir = fixture("import-throw-project");
const relativePath = path.join("features", "steps", "reads-url.ts");
const thrownMessage = "Cannot read properties of undefined (reading 'url')";
const reported = `refused\tstep-file-import-failed\t-\t${relativePath}: ${thrownMessage}\n  fix: Correct the import or the error that the message names in the file, then run nuka check again.\n  do: nuka check\n`;

async function run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli([...argv], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe("a step file that throws on import", () => {
  it("nuka run names the file on stderr and exits 2", async () => {
    const result = await run(["run", "--no-check", "features/a.feature"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(reported);
    expect(result.stdout).toBe("");
  });

  it("nuka do names the file on stderr and exits 2", async () => {
    const result = await run(["do", "anything", "--args", "{}"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(reported);
    expect(result.stdout).toBe("");
  });

  it("keeps the original failure as the thrown error's cause", async () => {
    const error = await discoverSteps(rootDir, "features").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`${relativePath}: ${thrownMessage}`);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(((error as Error).cause as TypeError).message).toBe(thrownMessage);
  });
});
