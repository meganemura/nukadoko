import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/run-cli.js";
import { defineWorld, drainWorldSchemaRegistrations } from "../src/compat/define-world.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `defineWorld({ page })` and `defineWorld({ request })`
// name harness getters. Reading either getter before openPage()/openRequest()
// throws WorldNotOpenedError. Instrumentation seeds a declared key by
// reading it, so a registration that is accepted makes `nuka check` report
// nothing and then crashes `nuka run` with that opener error. Both commands
// have to refuse the declaration, and the message has to name the field.

const HARNESS_GETTERS = ["page", "request"] as const;

function refusal(field: (typeof HARNESS_GETTERS)[number]): string {
  return `defineWorld cannot declare "${field}"`;
}

function stepSource(field: (typeof HARNESS_GETTERS)[number]): string {
  return `import { z } from "zod";
import { Given, defineWorld } from "../../nukadoko-compat-shim.js";

defineWorld({ ${field}: z.string().optional() });

Given("the world is ready", async function () {});
`;
}

describe("defineWorld: page and request", () => {
  it("refuses each harness getter at registration, before the schema is buffered", () => {
    drainWorldSchemaRegistrations();
    try {
      for (const field of HARNESS_GETTERS) {
        expect(() => defineWorld({ [field]: z.string().optional() })).toThrow(refusal(field));
        expect(drainWorldSchemaRegistrations()).toEqual([]);
      }
    } finally {
      drainWorldSchemaRegistrations();
    }
  });

  it("nuka check and nuka run both fail, and both messages name the field", async () => {
    for (const field of HARNESS_GETTERS) {
      const rootDir = await copyFixtureToTempDir("define-world-harness-getter-project");
      try {
        await writeFile(path.join(rootDir, "features/steps/declare.ts"), stepSource(field));

        const checkStdout = createCaptureSink();
        const checkStderr = createCaptureSink();
        const checkExit = await runCli(["check", "--json"], {
          rootDir,
          stdout: checkStdout,
          stderr: checkStderr,
        });
        const report = JSON.parse(checkStdout.text()) as {
          errors: Array<{ code: string; message: string }>;
        };
        const importFailure = report.errors.find((issue) => issue.code === "step-file-import-failed");

        const runStdout = createCaptureSink();
        const runStderr = createCaptureSink();
        let runExit: number;
        let runText: string;
        try {
          runExit = await runCli(["run", "features/harness.feature"], {
            rootDir,
            stdout: runStdout,
            stderr: runStderr,
          });
          runText = `${runStdout.text()}\n${runStderr.text()}`;
        } catch (error) {
          runExit = 1;
          runText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }

        // One comparison so a mismatch prints what check reported beside
        // what run reported. Split expects would hide the second command.
        expect({
          checkExit,
          importMessage: importFailure?.message ?? "",
          runExit,
          runText,
        }).toEqual({
          checkExit: 1,
          importMessage: expect.stringContaining(refusal(field)),
          runExit: 1,
          runText: expect.stringContaining(refusal(field)),
        });
      } finally {
        await removeTempDir(rootDir);
      }
    }
  });
});
