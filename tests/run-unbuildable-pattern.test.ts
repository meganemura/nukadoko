import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a step whose pattern cannot be built matches nothing, so
// its line reports as undefined. `nuka run` says why before running, once,
// naming the step and the `nuka check` code, instead of leaving "not
// registered" to look exactly like "does not pass". The pattern here is
// the one a person actually wrote when this was reported: `{state}`, a
// placeholder with no `:type`, which nukadoko's own capture syntax reads
// as an unnamed capture rather than as a parameter type.

describe("nuka run with a pattern that cannot be built", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    await writeFile(
      path.join(rootDir, "features", "steps", "viewer-state.ts"),
      [
        'import { z } from "zod";',
        'import { defineStep } from "../../nukadoko-shim.js";',
        "",
        "export default defineStep({",
        '  pattern: "the viewer is in {state}",',
        '  description: "Names the viewer state",',
        "  args: z.object({ state: z.string() }),",
        "  returns: z.object({}),",
        "  mutates: false,",
        "  async run() {",
        "    return {};",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await mkdir(path.join(rootDir, "features"), { recursive: true });
    await writeFile(
      path.join(rootDir, "features", "viewer.feature"),
      "Feature: Viewer\n\n  Scenario: state\n    Given the viewer is in \"review\"\n",
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("warns before running, naming the step, the missing type, and the check code", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/viewer.feature"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);

    const text = stderr.text();
    expect(text).toMatch(/^Warning: Step "viewer-state" pattern "the viewer is in \{state\}": /m);
    expect(text).toContain("Every line meant for this step reports as undefined; nuka check names this as unnamed-capture.");
    // Said once, before the scenario's own lines.
    expect(text.indexOf("Warning: Step")).toBeLessThan(text.indexOf("viewer.feature"));
    expect(text.split("Warning: Step").length - 1).toBe(1);

    const [record] = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(record.steps[0].status).toBe("undefined");
  });
});
