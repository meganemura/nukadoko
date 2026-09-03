import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: one line can take one args key from `from` and the other
// from its docstring. The rule that places a table/docstring against "the
// one required key nobody speaks for" has to count a `from` key as spoken
// for, in check and in run alike; this is the shape a real suite wrote and
// was refused with table-docstring-key-mismatch on both sides.

describe("a from key and a docstring on the same line", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(
      path.join(rootDir, "features", "steps", "name-is-exactly.ts"),
      [
        'import { z } from "zod";',
        'import { defineStep } from "../../nukadoko-shim.js";',
        'import visitorArrives from "./visitor-arrives.js";',
        "",
        "export default defineStep({",
        '  pattern: "the name is exactly",',
        '  description: "Compares the arrived visitor\'s name with the docstring",',
        "  args: z.object({ name: z.string(), expected: z.string() }),",
        '  from: { name: [visitorArrives, "name"] },',
        "  returns: z.object({ ok: z.boolean(), name: z.string(), expected: z.string() }),",
        "  mutates: false,",
        "  async run({}, args) {",
        "    return { ok: args.name === args.expected, name: args.name, expected: args.expected };",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, "features", "chained.feature"),
      'Feature: Chained\n\n  Scenario: from and docstring\n    Given a visitor named "Ada" arrives\n    Then the name is exactly\n      """\n      Ada\n      """\n',
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("passes nuka check", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "features/chained.feature"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode, stdout.text()).toBe(0);
    expect(stdout.text()).not.toContain("table-docstring-key-mismatch");
  });

  it("runs, with the from key filled by the earlier step and the docstring bound to the other", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/chained.feature"], { rootDir, stdout, stderr });
    expect(exitCode, stderr.text()).toBe(0);
    const [record] = stdout.text().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
    expect(record.steps.map((step: { status: string }) => step.status)).toEqual(["passed", "passed"]);
  });

  it("still refuses a docstring when two required keys are left with nothing to fill them", async () => {
    await writeFile(
      path.join(rootDir, "features", "steps", "name-is-exactly.ts"),
      [
        'import { z } from "zod";',
        'import { defineStep } from "../../nukadoko-shim.js";',
        "",
        "export default defineStep({",
        '  pattern: "the name is exactly",',
        '  description: "Two required keys, nothing chained",',
        "  args: z.object({ name: z.string(), expected: z.string() }),",
        "  returns: z.object({ ok: z.boolean() }),",
        "  mutates: false,",
        "  async run() {",
        "    return { ok: true };",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "features/chained.feature"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(1);
    expect(stdout.text()).toContain("table-docstring-key-mismatch");
    expect(stdout.text()).toContain("2 args keys are left unconsumed (name, expected)");
  });
});
