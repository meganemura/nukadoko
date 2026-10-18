import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: a plain `nuka tend` reports every code, the declaration
// code (a field with no `.describe()`) included, and `--all` is refused by
// name. The project is fresh from `init` and `scaffold`, where the
// declaration code is the only note there is.

describe("nuka tend on a freshly scaffolded project", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    const sink = createCaptureSink();
    const initExit = await runCli(["init"], { rootDir, stdout: sink, stderr: sink });
    expect(initExit, sink.text()).toBe(0);
    expect(
      await runCli(["scaffold", "greet", "--pattern", "I greet {who:string}", "--description", "Greet someone by name"], {
        rootDir,
        stdout: sink,
        stderr: sink,
      }),
    ).toBe(0);
    // A feature line binds the step and the description is not the TODO, so
    // pattern-unbound and step-description-todo have nothing to say.
    await mkdir(path.join(rootDir, "features"), { recursive: true });
    await writeFile(
      path.join(rootDir, "features", "greet.feature"),
      ["Feature: Greet", "", "  Scenario: Greet someone", '    When I greet "Ada"', ""].join("\n"),
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports the declaration note in text, beside the declared: count", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    expect(await runCli(["tend"], { rootDir, stdout, stderr })).toBe(0);
    const codesInText = [...stdout.text().matchAll(/^note\t([^\t]+)\t/gm)].map((match) => match[1]);
    expect(codesInText).toEqual(["schema-field-undescribed"]);
    expect(stdout.text()).toMatch(/^note\tschema-field-undescribed\tfeatures\/steps\/greet\.ts\t/m);
    expect(stdout.text()).toContain("declared: describe 0/1\n");
    expect(stderr.text()).toBe("");
  });

  it("reports the declaration note in --json", async () => {
    const json = createCaptureSink();
    expect(await runCli(["tend", "--json"], { rootDir, stdout: json, stderr: createCaptureSink() })).toBe(0);
    const report = bySeverity(json.text()) as { notes: Array<{ code: string; step: string }> };
    expect(report.notes.map((note) => [note.code, note.step])).toEqual([["schema-field-undescribed", "greet"]]);
  });

  it("turns red when --fail-on names the declaration code", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    expect(await runCli(["tend", "--fail-on", "schema-field-undescribed"], { rootDir, stdout, stderr })).toBe(1);
    expect(stderr.text()).toBe("fail-on: schema-field-undescribed reported 1 finding\n");
  });

  it("refuses --all by name and says a plain run reports every code", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    expect(await runCli(["tend", "--json", "--all"], { rootDir, stdout, stderr })).toBe(2);
    expect(stdout.text() + stderr.text()).toContain("nuka tend --all is removed: a plain nuka tend reports every code.");
  });
});
