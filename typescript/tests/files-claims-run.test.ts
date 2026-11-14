import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { MAX_ENTRIES } from "../src/context/file-snapshot.js";
import { bySeverity } from "./helpers/envelope.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a claim on the files an earlier step's commands changed
// end to end, through `nuka run`, `nuka do --use`, and `nuka check`
// against tests/fixtures/files-project, whose producers run a stand-in
// build through `runCommand` (or write without one). A Then judges the
// paths the producer's record lists, and never a value its code
// returned: an empty list holds only when every process was walked whole,
// a producer that ran no process leaves the claim unjudged, and so does a
// walk that was not made.

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

interface ClaimFacts {
  readonly actual?: unknown;
  readonly actual_from: string;
  readonly expected: unknown;
  readonly expected_from: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly measured: { readonly step_record_id: string; readonly channel: string } | null;
}

interface StepFacts {
  readonly text: string;
  readonly step_record_id: string;
  readonly claims?: readonly ClaimFacts[];
}

function claimsOf(rootDir: string): Map<string, (readonly [string, ClaimFacts, readonly StepFacts[]])[]> {
  const run = latestRunJson(rootDir);
  const out = new Map<string, (readonly [string, ClaimFacts, readonly StepFacts[]])[]>();
  for (const scenario of run.scenarios as { scenario: string; steps: StepFacts[] }[]) {
    out.set(
      scenario.scenario,
      scenario.steps.flatMap((step) => (step.claims ?? []).map((claim) => [step.text, claim, scenario.steps] as const)),
    );
  }
  return out;
}

function feature(scenarios: readonly (readonly [string, readonly string[]])[]): string {
  return ["Feature: What the build wrote", "", ...scenarios.flatMap(([name, lines]) => [`  Scenario: ${name}`, ...lines.map((line) => `    ${line}`), ""])].join("\n");
}

/** Each claim of the latest run as its outcome, its reason, where it was
 * measured, and whether it has an actual value. */
const unjudgedOf = (rootDir: string) =>
  [...claimsOf(rootDir).values()].flat().map(([, claim]) => [claim.outcome, claim.reason, claim.measured, "actual" in claim]);

const ONE_PROCESS = "observed.processes[0].files";

describe("a claim on the files an earlier step changed, under nuka run", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("files-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("holds on what the build's command did and breaks on what it did not, naming the producer's record as where it was measured", async () => {
    await writeFile(
      path.join(rootDir, "features", "files.feature"),
      feature([
        ["a check", ['When the build runs with "check"', "Then the build writes nothing", "And the build changed no file under src/"]],
        [
          "a migration",
          [
            'When the build runs with "migrate"',
            'Then the build wrote the migration file "migrations/0002_add_note.sql"',
            "And the build wrote exactly these files:",
            '  """',
            "  migrations/",
            "  migrations/0002_add_note.sql",
            "  src/generated.ts",
            '  """',
            "And the build changed no file under src/",
          ],
        ],
        ["a clean", ['When the build runs with "clean"', "Then the build removed 1 file", 'And the build wrote the migration file "src/index.ts"']],
      ]),
    );
    const { exitCode } = await cli(rootDir, ["run"]);
    expect(exitCode).toBe(1);
    const claims = claimsOf(rootDir);
    const outcomes = (name: string) => claims.get(name)!.map(([text, claim]) => [text, claim.outcome, claim.actual ?? null]);
    expect(outcomes("a check")).toEqual([
      ["the build writes nothing", "held", []],
      ["the build changed no file under src/", "held", []],
    ]);
    expect(outcomes("a migration")).toEqual([
      ['the build wrote the migration file "migrations/0002_add_note.sql"', "held", ["migrations/", "migrations/0002_add_note.sql", "src/generated.ts"]],
      ["the build wrote exactly these files:", "held", ["migrations/", "migrations/0002_add_note.sql", "src/generated.ts"]],
      ["the build changed no file under src/", "broken", ["src/generated.ts"]],
    ]);
    expect(outcomes("a clean")).toEqual([
      ["the build removed 1 file", "held", 1],
      ['the build wrote the migration file "src/index.ts"', "broken", []],
    ]);
    for (const [, claim, steps] of [...claims.values()].flat()) {
      expect(claim.measured).toEqual({ step_record_id: steps[0]!.step_record_id, channel: ONE_PROCESS });
    }
    const [, nothing] = claims.get("a check")![0]!;
    expect(nothing).toMatchObject({ actual_from: "files:run-build@4 added, changed, or removed", expected: [], expected_from: "literal:nothing" });
    const [, exactly] = claims.get("a migration")![1]!;
    expect(exactly).toMatchObject({ actual_from: "files:run-build@9 added or changed", expected_from: "sentence:docstring as lines" });
  });

  it("leaves the claim unjudged, with the reason, where the producer ran no process or ran them in two directories", async () => {
    await writeFile(
      path.join(rootDir, "features", "files.feature"),
      feature([
        ["in-process", ["When the build runs in-process", "Then the build writes nothing"]],
        ["two directories", ["When the build runs in two directories", "Then the build writes nothing"]],
      ]),
    );
    const { exitCode, stdout, stderr } = await cli(rootDir, ["run"]);
    expect(exitCode).toBe(1);
    expect(unjudgedOf(rootDir)).toEqual([
      ["unjudged", "build-in-process@4 ran no runCommand process, so nukadoko measured no file for it, and a list it never measured is not an empty list", null, false],
      [
        "unjudged",
        `the commands of build-in-two-dirs@8 ran in 2 working directories, ${rootDir} and ${path.join(rootDir, "src")}, and each lists its paths relative to its own, so they make no one list`,
        null,
        false,
      ],
    ]);
    expect(stdout + stderr).toContain(
      "claim unjudged: files:build-in-process@4 added, changed, or removed equal [] (literal:nothing): build-in-process@4 ran no runCommand process, so nukadoko measured no file for it, and a list it never measured is not an empty list",
    );
  });

  it("leaves the claim unjudged where the walk was not made", async () => {
    await mkdir(path.join(rootDir, "big"));
    // One at a time: twenty thousand writes at once run out of file handles.
    for (let index = 0; index <= MAX_ENTRIES; index += 1) writeFileSync(path.join(rootDir, "big", `f${index}`), "");
    await writeFile(path.join(rootDir, "features", "files.feature"), feature([["too large to walk", ["When the build runs in the big tree", "Then the build writes nothing"]]]));
    const { exitCode } = await cli(rootDir, ["run"]);
    expect(exitCode).toBe(1);
    expect(unjudgedOf(rootDir)).toEqual([
      ["unjudged", `nukadoko did not measure the files process 1 of build-in-big-tree@4 changed: more than ${MAX_ENTRIES} entries under the working directory`, null, false],
    ]);
  }, 60_000);

  it("reads the record --use names under nuka do, refuses two records for one key, and leaves the claim unjudged when none names the producer", async () => {
    const build = await cli(rootDir, ["do", "run-build", "--args", '{"mode":"edit"}']);
    expect(build.exitCode).toBe(0);
    const id = (JSON.parse(build.stdout) as { step_record_id: string }).step_record_id;
    const exactly = await cli(rootDir, ["do", "wrote-exactly", "--args", JSON.stringify({ docstring: "src/index.ts" }), "--use", id]);
    expect(exactly.exitCode).toBe(0);
    expect((JSON.parse(exactly.stdout) as { claims: ClaimFacts[] }).claims).toEqual([
      expect.objectContaining({ actual: ["src/index.ts"], actual_from: `files:run-build@${id} added or changed`, outcome: "held", measured: { step_record_id: id, channel: ONE_PROCESS } }),
    ]);
    const again = await cli(rootDir, ["do", "run-build", "--args", '{"mode":"check"}']);
    const second = (JSON.parse(again.stdout) as { step_record_id: string }).step_record_id;
    const both = await cli(rootDir, ["do", "wrote-exactly", "--args", JSON.stringify({ docstring: "src/index.ts" }), "--use", id, "--use", second]);
    expect(both.exitCode).toBe(2);
    expect(both.stdout + both.stderr).toContain(
      `--use: files key "written" is supplied by both step record ${id} (step "run-build") and step record ${second} (step "run-build"), and nuka do reads the files of one step record per key`,
    );
    const unused = await cli(rootDir, ["do", "no-src-change", "--args", "{}"]);
    expect(unused.exitCode).toBe(1);
    expect((JSON.parse(unused.stdout) as { claims: ClaimFacts[] }).claims[0]).toMatchObject({
      outcome: "unjudged",
      reason: 'files.source.of names "run-build", and no --use value names a step record of it, so nuka do has no files to read',
    });
  });
});

describe("the vocabulary of a files key", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("files-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names the producer, the changes, and the directory in nuka steps and nuka describe", async () => {
    const steps = await cli(rootDir, ["steps"]);
    expect(steps.stdout).toContain("  files: source lists the files the commands of run-build added, changed, or\n    removed under src/\n");
    expect(steps.stdout).toContain("  files: written lists the files the commands of run-build added or changed\n");
    const described = await cli(rootDir, ["describe", "wrote-exactly"]);
    expect((JSON.parse(described.stdout) as { files: unknown }).files).toEqual({ written: { of: ["run-build"], change: ["added", "changed"] } });
    const under = await cli(rootDir, ["describe", "no-src-change"]);
    expect((JSON.parse(under.stdout) as { files: unknown }).files).toEqual({ source: { of: ["run-build"], under: "src/" } });
  });
});

describe("nuka check: the order of a files producer", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("files-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names a claim line whose producer no earlier line runs, or two candidates ran before it", async () => {
    await writeFile(
      path.join(rootDir, "features", "files.feature"),
      feature([
        ["no producer", ["Then the build changed no file under src/"]],
        ["two producers", ["When the build runs in-process", 'And the build runs with "check"', "Then the build writes nothing"]],
        ["one producer", ['When the build runs with "check"', "Then the build writes nothing"]],
      ]),
    );
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(1);
    const { errors } = bySeverity(stdout.text()) as { errors: { code: string; line?: number; message: string; fix?: string }[] };
    expect(errors.map(({ code, line, message, fix }) => ({ code, line, message, fix }))).toEqual([
      {
        code: "files-producer-missing",
        line: 4,
        message:
          'Step "no-src-change"\'s files.source reads the files the commands of step "run-build" changed, and no earlier line runs it: "run-build" runs nowhere in this scenario. Each claim on the list is unjudged',
        fix: 'Put a line that runs step "run-build" earlier in the scenario, or, if an earlier line runs the step whose files the claim means, list that step in files.source.of of step "no-src-change".',
      },
      {
        code: "files-producer-ambiguous",
        line: 9,
        message:
          'Step "writes-nothing"\'s files.written reads the files the commands of one of steps "run-build", "build-in-process", "build-in-two-dirs", and "build-in-big-tree" changed, and "run-build" and "build-in-process" each ran earlier in this scenario, so the run cannot choose whose files to read, and each claim on the list is unjudged',
        fix: 'Remove or move lines so that exactly one of steps "run-build" and "build-in-process" runs before this line.',
      },
    ]);
  });
});
