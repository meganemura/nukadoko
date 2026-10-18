import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

async function refusal(argv: string[], root: string): Promise<{ exitCode: number; do: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli([...argv, "--json"], { rootDir: fixture(root), stdout, stderr });
  return { exitCode, do: (JSON.parse(stdout.text()) as { do: string }).do };
}

describe("a duplicate in the vocabulary names both files in its do", () => {
  it("two step files with one name", async () => {
    expect(await refusal(["check"], "duplicate-steps-project")).toEqual({ exitCode: 2, do: "Rename features/steps/nested/foo.ts or features/steps/foo.ts: a typed step's name is its file name, so the two files register the same step." });
  });

  it("two compat registrations of one pattern", async () => {
    expect(await refusal(["steps"], "compat-duplicate-project")).toEqual({ exitCode: 2, do: 'Remove one of the two registrations of "shared pattern here", in features/steps/a-glue.ts or features/steps/b-glue.ts.' });
  });

  it("two defineWorld calls", async () => {
    expect(await refusal(["steps"], "typed-world-duplicate-project")).toEqual({ exitCode: 2, do: "Keep one defineWorld call: remove the one in features/steps/second-world.ts or the one in features/steps/first-world.ts." });
  });
});
