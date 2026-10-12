import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a table reaches its args key as string[][] and a docstring
// as a string. A key of a type that attachment can never satisfy must be
// reported by `nuka check` with the same verdict `nuka run` reaches, and a
// key the check cannot classify must stay silent.

function stepFile(pattern: string, argsSchema: string): string {
  return [
    'import { z } from "zod";',
    'import { defineStep } from "../../nukadoko-shim.js";',
    "",
    "export default defineStep({",
    `  pattern: ${JSON.stringify(pattern)},`,
    '  description: "Takes one attachment",',
    `  args: z.object({ value: ${argsSchema} }),`,
    "  returns: z.object({ ok: z.boolean() }),",
    "  mutates: false,",
    "  async run() {",
    "    return { ok: true };",
    "  },",
    "});",
    "",
  ].join("\n");
}

const TABLE = "\n      | a | b |\n      | c | d |\n";
const DOCSTRING = '\n      """\n      text\n      """\n';

const cases = [
  { name: "a table on a string key", schema: "z.string()", attach: TABLE, reported: true, runsClean: false },
  { name: "a docstring on an array key", schema: "z.array(z.array(z.string()))", attach: DOCSTRING, reported: true, runsClean: false },
  { name: "a docstring on a number key", schema: "z.number()", attach: DOCSTRING, reported: true, runsClean: false },
  { name: "a docstring on an object key", schema: "z.object({ a: z.string() })", attach: DOCSTRING, reported: true, runsClean: false },
  { name: "a table on an array key", schema: "z.array(z.array(z.string()))", attach: TABLE, reported: false, runsClean: true },
  { name: "a docstring on a string key", schema: "z.string()", attach: DOCSTRING, reported: false, runsClean: true },
  { name: "a docstring on a coercing number key", schema: "z.coerce.number()", attach: DOCSTRING, reported: false, runsClean: false },
  { name: "a table on a transformed string key", schema: "z.string().transform((v) => v)", attach: TABLE, reported: false, runsClean: false },
];

describe("a table or docstring attached to a key of the wrong type", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  for (const { name, schema, attach, reported, runsClean } of cases) {
    it(`${reported ? "fails check and run" : "passes check and run"} for ${name}`, async () => {
      await writeFile(path.join(rootDir, "features", "steps", "takes-attachment.ts"), stepFile("it takes the attachment", schema));
      await writeFile(
        path.join(rootDir, "features", "attach.feature"),
        `Feature: Attach\n\n  Scenario: one attachment\n    Given it takes the attachment${attach}`,
      );
      const checkOut = createCaptureSink();
      const checkExit = await runCli(["check", "features/attach.feature"], {
        rootDir,
        stdout: checkOut,
        stderr: createCaptureSink(),
      });
      const runOut = createCaptureSink();
      const runExit = await runCli(["run", "features/attach.feature"], {
        rootDir,
        stdout: runOut,
        stderr: createCaptureSink(),
      });
      if (reported) {
        expect(checkExit, checkOut.text()).toBe(1);
        expect(checkOut.text()).toContain("table-docstring-key-mismatch");
        expect(runExit, runOut.text()).not.toBe(0);
      } else {
        expect(checkExit, checkOut.text()).toBe(0);
        expect(checkOut.text()).not.toContain("table-docstring-key-mismatch");
        // Silence is not a promise that the run passes: a transform or a
        // coerced "text" may still fail, which is the run's to settle.
        if (runsClean) {
          expect(runExit, runOut.text()).toBe(0);
        }
      }
    });
  }
});
