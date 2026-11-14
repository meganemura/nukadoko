import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the two `nuka check` findings about `@expects:` tags,
// against tests/fixtures/underneath-project: a tag that does not read is an
// error where the file writes it, and an `@expects:error=` tag where no
// world the run starts reads execution events is a warning. A project whose
// tags all read, with a world that reads events, gets neither.

interface Finding {
  readonly severity: string;
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
  readonly message: string;
}

async function check(rootDir: string, argv: readonly string[]): Promise<{ exitCode: number; findings: readonly Finding[] }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", ...argv, "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  const document = JSON.parse(stdout.text()) as { findings: readonly Finding[] };
  return { exitCode, findings: document.findings.filter((finding) => finding.code.startsWith("expects-")) };
}

describe("nuka check: @expects tags", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("underneath-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports nothing when every tag reads and a world reads execution events", async () => {
    expect(await check(rootDir, [])).toEqual({ exitCode: 0, findings: [] });
  });

  it("reports each tag that does not read, where the file writes it", async () => {
    await writeFile(
      path.join(rootDir, "features", "tags.feature"),
      [
        "Feature: tags",
        "",
        "  @expects:status=404 @expects:status=5xx",
        "  Scenario: statuses a run never judges",
        '    When the client gets "/down"',
        "",
        "  @expects:page-error @expects:sttaus=500 @expects:error=",
        "  Scenario: tags with no kind or no value",
        '    When the client gets "/down"',
        "",
      ].join("\n"),
    );
    const { exitCode, findings } = await check(rootDir, ["features/tags.feature"]);
    expect(exitCode).toBe(1);
    const at = (line: number, message: string): Finding => ({ severity: "error", code: "expects-tag-malformed", file: "features/tags.feature", line, message });
    expect(findings.map(({ severity, code, file, line, message }) => ({ severity, code, file, line, message }))).toEqual([
      at(3, "@expects:status=404 does not name a status from 500 to 599, so it accepts nothing: a run judges no other status, and one tag names one status"),
      at(3, "@expects:status=5xx does not name a status from 500 to 599, so it accepts nothing: a run judges no other status, and one tag names one status"),
      at(7, "@expects:page-error names no value, and an @expects tag names what it accepts: the name of an error the page threw, such as TypeError"),
      at(
        7,
        "@expects:sttaus=500 does not read as @expects:status=<500-599>, @expects:error=<class>, or @expects:page-error=<name>, so it accepts nothing",
      ),
      at(7, "@expects:error= names no value, and an @expects tag names what it accepts: the class of an error the program reports with handled: false"),
    ]);
  });

  it("warns on an @expects:error= tag when no world the run starts reads execution events", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      ['import { defineProgram } from "./nukadoko-shim.js";', 'export default defineProgram({ serve: { command: "node app/server.mjs", ready: "/up" }, env: { PORT: "{port}" } });', ""].join("\n"),
    );
    const { exitCode, findings } = await check(rootDir, []);
    expect(exitCode).toBe(0);
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "expects-unread",
        file: "features/underneath.feature",
        line: 15,
        message:
          "@expects:error=Boom::Exploded accepts an unhandled error the program reports in its execution events, and no world this run starts reads them " +
          "(world default: the program file names no {events}), so the tag can never match",
      }),
    ]);
  });
});
