import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: cli/run.ts's own runOneRunHook applies the same two
// refusal shapes to a run-scope hook (BeforeAll/AfterAll) that
// src/run/run-scenario.ts's own scenario-level Before/After hooks get,
// reusing that file's doneCallbackMessage/pendingOrSkippedMessage: no
// test yet drives either one through a *run-scope* hook specifically.
// Against tests/fixtures/compat-run-all-hooks-arity-project: BeforeAll
// declares an extra parameter (the done-callback shape cucumber-js would
// infer), and AfterAll returns "pending".

describe("nuka run: BeforeAll/AfterAll refusal shapes", () => {
  it('names a done()-callback-shaped BeforeAll, stopping every scenario, and separately reports AfterAll\'s own "pending" return', async () => {
    const rootDir = await copyFixtureToTempDir("compat-run-all-hooks-arity-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/one-scenario.feature"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain('Hook "BeforeAll" appears to expect a done() callback');
      expect(stderr.text()).toContain('Hook "AfterAll" returned "pending"');
      // BeforeAll's own failure stops every scenario from ever beginning,
      // same convention tests/compat-run-scope.test.ts already proves for
      // its own timeout case.
      expect(stdout.text()).toBe("");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
