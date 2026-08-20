import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own buildStepBindings() setup failure
// (cli/run.ts): a config.parameterTypes entry that collides with one of
// cucumber-expressions' own built-in types. tests/binding-expression.test.ts
// already proves buildStepBindings() itself throws
// ParameterTypeCollisionError for this shape; no test yet drives that
// failure through `nuka run`'s own setup phase, which treats it as fatal
// before any pickle executes (no scenario record is ever written), so this
// runs read-only against the committed fixture.

describe("nuka run: a config.parameterTypes entry colliding with a built-in type", () => {
  it("fails setup with exit 1, naming the collision, before any scenario runs", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/noop.feature"], {
      rootDir: fixture("run-parameter-type-collision-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain('"int"');
    expect(stderr.text()).toContain("built-in");
  });
});
