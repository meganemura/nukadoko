import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyTempDir, ensureNukadokoShim, latestRunJson, removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// Responsibility: a step that calls `process.exit` does not choose the exit
// code of `nuka run` or `nuka do`. The call fails the step, and the run
// goes on to its own verdict. The CLI runs in a process of its own: the
// test runner replaces `process.exit` in its own process, so an in-process
// run never reaches the real one.

const SPAWNED_TEST_TIMEOUT_MS = 60_000;

const LEAVE_STEP = `import { z } from "zod";
import { defineStep } from "nukadoko";
export default defineStep({
  pattern: "the step leaves by {how:word}",
  description: "Calls process.exit",
  args: z.object({ how: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run({}, { how }) {
    if (how === "call") process.exit(0);
    if (how === "code") process.exit(3);
    if (how === "timer") {
      setTimeout(() => process.exit(0), 5);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (how === "throw") {
      setTimeout(() => { throw new Error("thrown from a timer"); }, 5);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {};
  },
});
`;

const COUNT_STEP = `import { z } from "zod";
import { defineStep } from "nukadoko";
export default defineStep({
  pattern: "the count is {count:int}",
  description: "Returns the count",
  args: z.object({ count: z.number().int() }),
  returns: z.object({ count: z.number().int() }),
  mutates: false,
  async run({}, { count }) { return { count }; },
});
`;

const COUNT_IS_STEP = `import { z } from "zod";
import { defineStep } from "nukadoko";
import count from "./count.ts";
export default defineStep({
  pattern: "it reads {expected:int}",
  description: "Checks the count",
  args: z.object({ expected: z.number().int(), count: z.number().int() }),
  from: { count: [count, "count"] },
  claims: [{ actual: "count", compare: "equal", expected: "expected" }],
});
`;

let dir: string;

beforeEach(async () => {
  await ensureNukadokoShim();
  dir = await createEmptyTempDir();
  await mkdir(path.join(dir, "features", "steps"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
  await writeFile(path.join(dir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n');
  await writeFile(path.join(dir, "features", "steps", "leave.ts"), LEAVE_STEP);
  await writeFile(path.join(dir, "features", "steps", "count.ts"), COUNT_STEP);
  await writeFile(path.join(dir, "features", "steps", "count-is.ts"), COUNT_IS_STEP);
});

afterEach(async () => {
  await removeTempDir(dir);
});

function nuka(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: SPAWNED_TEST_TIMEOUT_MS,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function scenario(name: string, line: string): string {
  return `  Scenario: ${name}\n    ${line}\n`;
}

async function writeFeature(...scenarios: string[]): Promise<void> {
  await writeFile(path.join(dir, "features", "exit.feature"), `Feature: Exit\n\n${scenarios.join("\n")}`);
}

function outcomes(): { name: string; status: string; message: string | undefined }[] {
  type Scenario = { scenario: string; status: string; steps: { error?: { message: string } }[] };
  return (latestRunJson(dir).scenarios as Scenario[]).map((s) => ({
    name: s.scenario,
    status: s.status,
    message: s.steps.find((step) => step.error !== undefined)?.error?.message,
  }));
}

describe("a step that calls process.exit", () => {
  it(
    "fails the step in nuka run, which still ends with the exit code its own verdict gives",
    async () => {
      await writeFeature(
        scenario("wrong count", "Given the count is 2\n    Then it reads 5"),
        scenario("leaves", "When the step leaves by call"),
        scenario("after it", "Given the count is 2\n    Then it reads 2"),
      );
      const result = nuka(["run"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "failed\tscenario-failed\tfeatures/exit.feature:7\tleaves: process.exit(0) was called; project code cannot end nuka, so this fails instead",
      );
      expect(outcomes().map(({ name, status }) => [name, status])).toEqual([
        ["wrong count", "failed"],
        ["leaves", "failed"],
        ["after it", "passed"],
      ]);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "fails the step it ran in when it calls it from a timer, and the run goes on",
    async () => {
      await writeFeature(scenario("leaves later", "When the step leaves by timer"), scenario("after it", "Given the count is 2\n    Then it reads 2"));
      const result = nuka(["run"]);
      expect(result.status).toBe(1);
      expect(outcomes()).toEqual([
        {
          name: "leaves later",
          status: "failed",
          message:
            "process.exit(0) was called from a timer or a promise that nothing awaited; project code cannot end nuka, so the next step or hook to finish fails instead",
        },
        { name: "after it", status: "passed", message: undefined },
      ]);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "fails the step in nuka do, which prints its record and exits 1",
    async () => {
      const result = nuka(["do", "leave", "--args", '{"how":"code"}']);
      expect(result.status).toBe(1);
      const record = JSON.parse(result.stdout) as { status: string; error: { message: string; kind: string } };
      expect([record.status, record.error]).toEqual([
        "failed",
        { message: "process.exit(3) was called; project code cannot end nuka, so this fails instead", kind: "step_error" },
      ]);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "leaves any other error thrown where nothing catches it to end the process, as Node does",
    async () => {
      await writeFeature(scenario("throws later", "When the step leaves by throw"));
      const result = nuka(["run"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: thrown from a timer");
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );
});
