import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: three of `nuka do`'s own setup-phase refusals that
// `nuka run`'s sibling tests already prove for `nuka run` but no test yet
// drives through `nuka do`'s own copy of the same checks: a config load
// failure, a discoverSteps failure (duplicate step names), and
// config.fixtures' own structural findings (cycle/scope-violation/unowned
// override). Every case here fails before any step record is written, so
// each runs read-only against the committed fixture, the same choice
// tests/check-fixture-definitions.test.ts makes for the same reason.

describe("nuka do: setup-phase refusals not yet covered by nuka run's own tests", () => {
  it("propagates a config load failure as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "whatever", "--args", "{}"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("typo");
  });

  it("propagates a discoverSteps failure (two files sharing a step name) as exit 1", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "whatever", "--args", "{}"], {
      rootDir: fixture("duplicate-steps-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text().length).toBeGreaterThan(0);
  });

  it("refuses execution when config.fixtures itself is broken (cycle/scope-violation/unowned override)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "noop-step", "--args", "{}"], {
      rootDir: fixture("broken-fixtures-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toMatch(/fixture-cycle|cycle/i);
  });
});
