import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { removedExport } from "../src/config/removed-export.js";
import { bySeverity } from "./helpers/envelope.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a config or a step file that still imports an export
// nukadoko removed (src/config/removed-export.ts) is refused with what
// replaced it: the message and the `fix:` line name nukadoko.program.ts
// and the docs/upgrading.md entry, in `nuka check`, `nuka run`, and `nuka
// do`, where Node's own message named only the missing export.

const nodeMessage = (specifier: string, name: string): string => `The requested module '${specifier}' does not provide an export named '${name}'`;

const SENTENCE =
  "; runServer was removed from nukadoko: nukadoko.program.ts describes the program under test now, and nukadoko starts it once per run with serve: { command, ready } and stops it after";
const FIX =
  "Remove runServer and the fixture that called it, and write the program's command in nukadoko.program.ts instead; " +
  'docs/upgrading.md in the nukadoko package, under "The program under test moves to nukadoko.program.ts", shows the move.';

describe("removedExport", () => {
  it("names what replaced runServer when nukadoko is the module that lacks it", () => {
    expect(removedExport(nodeMessage("nukadoko", "runServer"))).toEqual({ sentence: SENTENCE, fix: FIX });
  });

  it("says nothing for any other export, or for runServer missing from any other module", () =>
    hegel.test((tc) => {
      const specifier = tc.draw(gs.sampledFrom(["nukadoko", "nukadoko/compat", "./helpers.js", "@acme/server"]));
      const name = tc.draw(gs.oneOf(gs.just("runServer"), gs.just("toString"), gs.just("__proto__"), gs.fromRegex("[A-Za-z][A-Za-z0-9]{0,12}")));
      tc.assume(!(specifier === "nukadoko" && name === "runServer"));
      expect(removedExport(nodeMessage(specifier, name))).toBeUndefined();
    }));
});

describe("a project that still imports runServer", () => {
  let rootDir: string;

  beforeEach(async () => {
    await ensureNukadokoShim();
    rootDir = await createEmptyTempDir();
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(path.join(rootDir, "package.json"), '{ "type": "module" }\n');
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(args, { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("refuses the config in nuka check and nuka run, naming the program file and the upgrading entry", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig, runServer } from "nukadoko";\nvoid runServer;\nexport default defineConfig({});\n',
    );
    for (const args of [["check"], ["run"]]) {
      const { exitCode, stderr } = await cli(args);
      expect(exitCode).toBe(2);
      expect(stderr).toContain(
        `refused\tconfig-invalid\t-\tCould not import config at ${path.join(rootDir, "nukadoko.config.ts")}: ` +
          `${nodeMessage("nukadoko", "runServer")} (nukadoko.config.ts:1)${SENTENCE}\n  fix: ${FIX}\n`,
      );
    }
  });

  it("reports the step file in nuka check, and refuses it in nuka run and nuka do, with the same fix", async () => {
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n');
    await writeFile(
      path.join(rootDir, "features", "steps", "start.ts"),
      [
        'import { z } from "zod";',
        'import { defineStep, runServer } from "nukadoko";',
        "export default defineStep({",
        '  pattern: "the server starts",',
        '  description: "starts a server the old way",',
        "  args: z.object({}),",
        "  returns: z.object({}),",
        "  mutates: false,",
        "  async run() {",
        "    void runServer;",
        "    return {};",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(rootDir, "features", "start.feature"), "Feature: Start\n\n  Scenario: start\n    When the server starts\n");

    const check = await cli(["check", "--json"]);
    expect(check.exitCode).toBe(1);
    const failures = (bySeverity(check.stdout) as { errors: { code: string; message: string; fix?: string }[] }).errors.filter(
      (issue) => issue.code === "step-file-import-failed",
    );
    expect(failures).toEqual([expect.objectContaining({ message: `${nodeMessage("nukadoko", "runServer")} (features/steps/start.ts:2)${SENTENCE}`, fix: FIX })]);

    for (const args of [["run", "--no-check"], ["do", "start", "--args", "{}"]]) {
      const { exitCode, stderr } = await cli(args);
      expect(exitCode).toBe(2);
      expect(stderr).toContain(
        `refused\tstep-file-import-failed\t-\tfeatures/steps/start.ts:2: ${nodeMessage("nukadoko", "runServer")} (features/steps/start.ts:2)${SENTENCE}\n  fix: ${FIX}\n  do: nuka check\n`,
      );
    }
  });
});
