import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a failed step that read a large upstream result. run.json
// carries a bounded preview of that result, marked truncated, and the
// producer's step record still holds it whole.

const PRODUCER = `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a large result is made",
  description: "Returns a megabyte of output",
  args: z.object({}),
  returns: z.object({ output: z.string(), exitCode: z.number() }),
  mutates: true,
  async run() {
    return { output: "x".repeat(1_000_000), exitCode: 3 };
  },
});
`;

const CONSUMER = `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import made from "./large-made.js";

export default defineStep({
  pattern: "the large result is refused",
  description: "Claims the large result is the word refused, which it is not",
  args: z.object({ output: z.string() }),
  from: { output: [made, "output"] },
  claims: [{ actual: "output", compare: "equal", expected: { literal: "refused" } }],
});
`;

const FEATURE = `Feature: A large upstream result

  Scenario: refuse it
    Given a large result is made
    Then the large result is refused
`;

describe("nuka run with a large used result", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    await writeFile(path.join(rootDir, "features", "steps", "large-made.ts"), PRODUCER);
    await writeFile(path.join(rootDir, "features", "steps", "large-refused.ts"), CONSUMER);
    await writeFile(path.join(rootDir, "features", "large.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("bounds the result in run.json and keeps the producer's record path", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--json", "features/large.feature"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(1);
    expect(stdout.text().length).toBeLessThan(100_000);
    const document = JSON.parse(stdout.text()) as { scenarios: { steps: { used?: { step: string; record: string; result: unknown; truncated?: true; result_bytes?: number }[] }[] }[] };
    const [used] = document.scenarios[0]!.steps[1]!.used!;
    expect(used).toEqual({
      step: "large-made",
      record: expect.stringMatching(/^steps\/[^/]+$/),
      result: { output: "x".repeat(1024), exitCode: 3 },
      truncated: true,
      result_bytes: 1_000_026,
    });
  });
});
