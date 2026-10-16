import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { DECLARATION_TEND_CODES, selectReportedNotes } from "../src/tend/note-selection.js";
import { TEND_CODES } from "../src/tend/types.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: what `nuka tend` reports by default. The two declaration
// codes (a missing `rationale`, a field with no `.describe()`) are left out
// unless `--all` is given or `--fail-on` names one; every other code is
// reported as before. The property tests pin the selection itself; the
// example runs the real command on a project fresh from `init` and
// `scaffold`, which is where the two codes used to be the only output.

const codes = gs.sampledFrom([...TEND_CODES].sort());
const notes = gs.arrays(
  gs.tuples(codes, gs.integers({ minValue: 0, maxValue: 1000 })).map(([code, id]) => ({ code, id })),
  { maxSize: 20 },
);

describe("selectReportedNotes", () => {
  it("with all, keeps every note in order", () =>
    hegel.test((tc) => {
      const input = tc.draw(notes);
      const failOn = tc.draw(gs.arrays(codes, { maxSize: 4 }));
      expect(selectReportedNotes(input, { all: true, failOn })).toEqual(input);
    }));

  it("without all, drops exactly the declaration notes that --fail-on does not name, keeping order", () =>
    hegel.test((tc) => {
      const input = tc.draw(notes);
      const failOn = tc.draw(gs.arrays(codes, { maxSize: 4 }));
      const kept = selectReportedNotes(input, { all: false, failOn });
      const expected = input.filter((note) => !DECLARATION_TEND_CODES.has(note.code) || failOn.includes(note.code));
      expect(kept).toEqual(expected);
    }));

  it("is a subset of TEND_CODES, so --fail-on accepts both declaration codes", () => {
    for (const code of DECLARATION_TEND_CODES) expect(TEND_CODES.has(code)).toBe(true);
  });
});

describe("nuka tend on a freshly scaffolded project", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    const sink = createCaptureSink();
    const initExit = await runCli(["init"], { rootDir, stdout: sink, stderr: sink });
    expect(initExit, sink.text()).toBe(0);
    expect(
      await runCli(["scaffold", "greet", "--pattern", "I greet {who:string}"], { rootDir, stdout: sink, stderr: sink }),
    ).toBe(0);
    // A feature line binds the step, so pattern-unbound has nothing to say
    // and only the two declaration codes are left to report.
    await mkdir(path.join(rootDir, "features"), { recursive: true });
    await writeFile(
      path.join(rootDir, "features", "greet.feature"),
      ["Feature: Greet", "", "  Scenario: Greet someone", '    When I greet "Ada"', ""].join("\n"),
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports no notes by default, and says --all names the declaration gaps", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    expect(await runCli(["tend"], { rootDir, stdout, stderr })).toBe(0);
    expect(stdout.text()).not.toMatch(/^note\t/m);
    expect(stdout.text()).toContain("declared: rationale 0/1, describe 0/1 (nuka tend --all names each one)\n");
    expect(stdout.text()).toContain("ok: nothing to tend\n");
  });

  it("reports the two declaration notes under --all, in text and in --json", async () => {
    const stdout = createCaptureSink();
    expect(await runCli(["tend", "--all"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    const codesInText = [...stdout.text().matchAll(/^note\t([^\t]+)\t/gm)].map((match) => match[1]);
    expect(codesInText.sort()).toEqual(["schema-field-undescribed", "step-rationale-missing"]);
    expect(stdout.text()).toContain("declared: rationale 0/1, describe 0/1\n");

    const json = createCaptureSink();
    expect(await runCli(["tend", "--all", "--json"], { rootDir, stdout: json, stderr: createCaptureSink() })).toBe(0);
    const report = JSON.parse(json.text());
    expect(report.notes.map((note: { code: string }) => note.code).sort()).toEqual([
      "schema-field-undescribed",
      "step-rationale-missing",
    ]);
  });

  it("leaves both out of --json by default, and reports the one --fail-on names", async () => {
    const json = createCaptureSink();
    expect(await runCli(["tend", "--json"], { rootDir, stdout: json, stderr: createCaptureSink() })).toBe(0);
    expect(JSON.parse(json.text()).notes).toEqual([]);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    expect(await runCli(["tend", "--fail-on", "step-rationale-missing"], { rootDir, stdout, stderr })).toBe(1);
    expect(stdout.text()).toMatch(/^note\tstep-rationale-missing\t/m);
    expect(stdout.text()).not.toMatch(/^note\tschema-field-undescribed\t/m);
    expect(stderr.text()).toContain("fail-on: step-rationale-missing reported 1 finding\n");
  });
});
