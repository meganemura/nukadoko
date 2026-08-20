import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka do`'s own fixture-teardown-error warning
// (cli/do.ts): the same "teardown failure never fails the step, but is
// still announced on stderr" shape tests/run-fixture-teardown-error.test.ts
// already proves for `nuka run`'s scenario-level teardown, exercised here
// through `nuka do` instead, against the same
// tests/fixtures/run-fixture-teardown-failure-project (its own
// `brokenTeardown` fixture is scope-agnostic; `nuka do` just resolves it
// through the scenario-scope fixture cache, same as any other step-level
// fixture).

describe("nuka do: a fixture whose own teardown fails", () => {
  it("still writes an ok step record, and warns on stderr naming the fixture and message", async () => {
    const rootDir = await copyFixtureToTempDir("run-fixture-teardown-failure-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "uses-broken-fixture", "--args", "{}"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      const record = JSON.parse(stdout.text());
      expect(record.status).toBe("ok");

      expect(stderr.text()).toContain('Warning: fixture "brokenTeardown" teardown failed');
      expect(stderr.text()).toContain("brokenTeardown's own teardown exploded on purpose");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
