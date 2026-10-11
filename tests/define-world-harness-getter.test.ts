import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/run-cli.js";
import {
  defineWorld,
  defineWorldDeclarationRefusal,
  drainWorldSchemaRegistrations,
} from "../src/compat/define-world.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `page` and `request` are harness getters. Reading either
// before openPage()/openRequest() throws WorldNotOpenedError, and
// instrumentation seeds a declared key by reading it. defineWorld has to
// refuse those names so nuka check and nuka run fail at import with a
// message that names the field.

const HARNESS_GETTERS = ["page", "request"] as const;
const CUCUMBER_RESERVED = ["attach", "log", "link", "parameters"] as const;
const UNDECLARABLE = new Set<string>([...HARNESS_GETTERS, ...CUCUMBER_RESERVED]);

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
        expect(importFailure?.message).toContain("harness getter");
        expect(runText).toContain("harness getter");
      } finally {
        await removeTempDir(rootDir);
      }
    }
  });

  it("still accepts a method name such as openPage", () => {
    drainWorldSchemaRegistrations();
    try {
      expect(defineWorldDeclarationRefusal("openPage")).toBeUndefined();
      defineWorld({ openPage: z.string().optional() });
      expect(Object.keys(drainWorldSchemaRegistrations()[0]!.schemas)).toEqual(["openPage"]);
    } finally {
      drainWorldSchemaRegistrations();
    }
  });

  it("refuses exactly the harness getters and the cucumber reserved names, for any other string", () => {
    hegel.test((tc) => {
      const key = tc.draw(gs.oneOf(gs.sampledFrom([...UNDECLARABLE]), gs.text()));
      const reason = defineWorldDeclarationRefusal(key);
      if (UNDECLARABLE.has(key)) {
        expect(reason).toEqual(expect.any(String));
        expect(`defineWorld cannot declare "${key}": ${reason}`).toContain(key);
        if (key === "page" || key === "request") {
          expect(reason).toContain("harness getter");
        } else {
          expect(reason).toBe("it is a reserved cucumber-js World field");
        }
      } else {
        expect(reason).toBeUndefined();
      }
    });
  });
});
