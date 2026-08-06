import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import type { StepSummary } from "../src/cli/vocabulary.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: P5 task spec's own completion condition 6 — `needs_
// browser` is `true` for a step that reaches `page` only *through* a
// fixture (never directly), the transitive closure src/step/step-needs.ts's
// `stepNeeds` now takes over the fixture dependency graph (scope item 11).
// Read-only against tests/fixtures/fixture-touches-browser-project — `nuka
// steps` never executes a step, so no temp copy is needed (same choice
// tests/steps-needs-json.test.ts already makes).

describe("nuka steps --json: needs_browser through a fixture", () => {
  it("is true for a step that only destructures a fixture reaching page", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("fixture-touches-browser-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as { steps: StepSummary[] };

    const viaLoggedIn = report.steps.find((s) => s.name === "via-logged-in-step");
    expect(viaLoggedIn?.needs).toEqual(["loggedIn"]);
    expect(viaLoggedIn?.needs_browser).toBe(true);

    const plain = report.steps.find((s) => s.name === "plain-step");
    expect(plain?.needs).toEqual([]);
    expect(plain?.needs_browser).toBe(false);
  });
});
