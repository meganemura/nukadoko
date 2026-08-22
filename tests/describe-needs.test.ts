import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka describe`'s own `needs`/`needs_browser` fields —
// this command's own yargs description calls its output "full contract"
// (run-cli.ts), so an agent choosing a step must not have to also call
// `nuka steps --json` to learn what it needs before running it. Same
// fixture project, and the same "true for one, false for the other" pair,
// as tests/steps-needs-json.test.ts's own `nuka steps --json` coverage —
// this file is that same claim, made for `describe` instead.

async function describeJson(rootDir: string, name: string): Promise<Record<string, unknown>> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["describe", name], { rootDir, stdout, stderr });
  expect(exitCode).toBe(0);
  expect(stderr.text()).toBe("");
  return JSON.parse(stdout.text()) as Record<string, unknown>;
}

describe("nuka describe: needs / needs_browser", () => {
  it("is true, with page in needs, for a step that destructures page", async () => {
    const contract = await describeJson(fixture("run-browser-project"), "touches-browser-directly");
    expect(contract.needs).toEqual(["page"]);
    expect(contract.needs_browser).toBe(true);
  });

  it("is false, with an empty needs array (not omitted), for a step that destructures neither page nor context", async () => {
    const contract = await describeJson(fixture("run-browser-project"), "no-browser-touch");
    expect(contract.needs).toEqual([]);
    expect(contract.needs_browser).toBe(false);
    expect(contract).toHaveProperty("needs");
    expect(contract).toHaveProperty("needs_browser");
  });

  it("omits needs and needs_browser entirely for a compat entry", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    // compat-project's own compat step name, same fixture
    // tests/steps-needs-json.test.ts's own compat coverage uses.
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("compat-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as { steps: Array<{ kind: string; name: string }> };
    const compatEntry = report.steps.find((s) => s.kind === "compat");
    expect(compatEntry).toBeDefined();

    const contract = await describeJson(fixture("compat-project"), compatEntry!.name);
    expect(contract).not.toHaveProperty("needs");
    expect(contract).not.toHaveProperty("needs_browser");
    void stdout;
    void stderr;
  });

  it("agrees with `nuka steps --json` on needs_error/needs_inferred for a step whose run() can't be read", async () => {
    // needs-inferred-project's own step, already exercised end to end for
    // `nuka steps --json` (tests/needs-inferred.test.ts) — this asserts
    // `nuka describe` reaches the exact same verdict for the same step,
    // through the shared computation both commands now call.
    const stepsStdout = createCaptureSink();
    const stepsExit = await runCli(["steps", "--json"], {
      rootDir: fixture("needs-inferred-project"),
      stdout: stepsStdout,
      stderr: createCaptureSink(),
    });
    // `steps` exits 1 whenever any step's own `needs` couldn't be read
    // (run-cli.ts's own "output is not withheld, only 'success' is" rule)
    // — expected here, not a test failure.
    expect(stepsExit).toBe(1);
    const stepsReport = JSON.parse(stepsStdout.text()) as {
      steps: Array<{ name: string; needs: unknown; needs_error?: string; needs_inferred?: unknown }>;
    };
    const legacyBasic = stepsReport.steps.find((s) => s.name === "legacy-basic");
    expect(legacyBasic).toBeDefined();
    expect(legacyBasic!.needs_error).toBeDefined();

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "legacy-basic"], {
      rootDir: fixture("needs-inferred-project"),
      stdout,
      stderr,
    });
    // Same reasoning as `steps` above, scoped to this one contract.
    expect(exitCode).toBe(1);
    const contract = JSON.parse(stdout.text()) as {
      needs: unknown;
      needs_error?: string;
      needs_inferred?: unknown;
    };
    expect(contract.needs).toBeNull();
    expect(contract.needs_error).toBe(legacyBasic!.needs_error);
    expect(contract.needs_inferred).toEqual(legacyBasic!.needs_inferred);
  });
});
