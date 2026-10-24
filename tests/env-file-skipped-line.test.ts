import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: a line the env-file parser does not load used to
// disappear. `nuka check` is the place that can say so before a run.
// The line number is the report. The line text is not, because the
// skipped text may be a secret.

describe("nuka check: env-file-skipped-line", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    if (rootDir !== undefined) {
      await removeTempDir(rootDir);
      rootDir = undefined;
    }
  });

  it("warns for a line that is not a binding, and not for one inside a quoted value", async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        "export default defineConfig({",
        '  envFiles: [".env"],',
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      [
        'import { defineProgram } from "./nukadoko-shim.js";',
        'export default defineProgram({ environments: { staging: { envFiles: [".env.staging"] } } });',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, ".env"),
      ["# comment", "", "TOKEN=abc123 # rotated", "NOT_A_BINDING", 'KEY="a"', ""].join("\n"),
    );
    await writeFile(
      path.join(rootDir, ".env.staging"),
      ['KEY="-----BEGIN', "MIIE", '-----END"', "ALSO_NOPE", ""].join("\n"),
    );

    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    const report = bySeverity(stdout.text());

    expect(exitCode).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      {
        code: "env-file-skipped-line",
        message: 'envFile ".env" line 4 was skipped, so nothing on it was loaded',
        file: ".env",
        line: 4,
        fix: "Rewrite the line as KEY=value, or start it with # to make it a comment.",
      },
      {
        code: "env-file-skipped-line",
        message: 'envFile ".env.staging" line 4 was skipped, so nothing on it was loaded',
        file: ".env.staging",
        line: 4,
        fix: "Rewrite the line as KEY=value, or start it with # to make it a comment.",
      },
    ]);
  });
});
