import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyExampleToTempDir,
  createCaptureSink,
  ensureNukadokoShim,
  latestRunJson,
  removeTempDir,
  repoRoot,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: anti-rot proof for examples/todo/README.md's two central,
// checkable claims: the example project, with the app its committed
// nukadoko.program.ts starts, runs green as v1 and fails under the v2
// environment, so the walkthrough's story ("the feature runs green" / "the
// field rename breaks it") cannot silently stop being true. Only that
// mechanical claim is asserted here; the repair loop itself (README.md,
// Part 2) is prose an agent enacts by hand, not something this suite
// re-derives.

async function runTodo(rootDir: string, args: string[]): Promise<{ exitCode: number; statuses: string[]; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["run", "--records", ...args, "features/todo.feature"], { rootDir, stdout, stderr });
  const statuses = stdout
    .text()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { status: string }).status);
  return { exitCode, statuses, stderr: stderr.text() };
}

describe("examples/todo", () => {
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs features/todo.feature green against the v1 app the program file starts", async () => {
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();

    const { exitCode, statuses, stderr } = await runTodo(rootDir, []);

    expect(stripRunProgressLines(stderr)).toBe("");
    expect(statuses).toEqual(["passed", "passed", "passed"]);
    expect(exitCode).toBe(0);
    expect(latestRunJson(rootDir).worlds).toEqual([expect.objectContaining({ name: "default", error: null })]);
  });

  it("fails the same feature under --env v2 (the field rename breaks it)", async () => {
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();

    const { exitCode, statuses } = await runTodo(rootDir, ["--env", "v2"]);

    expect(statuses).toEqual(["failed", "failed", "failed"]);
    expect(exitCode).toBe(1);
    expect(latestRunJson(rootDir).worlds).toEqual([expect.objectContaining({ name: "v2", error: null })]);
  });
});

describe("examples/todo check", () => {
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka check is clean for the committed feature", async () => {
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check"], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("ok: no issues found");
    expect(exitCode).toBe(0);
  });
});

// README.md's Part 1 shows two outputs a reader compares with their own
// terminal: what `nuka check` prints once the step is set aside, and what
// the scaffold command writes. Both come from running the commands here, so
// neither can drift from what the CLI prints today. The implemented step it
// then shows is the file the example ships.
describe("examples/todo README, Part 1", () => {
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  // The first fenced block of `lang` after `marker` in the README.
  function blockAfter(readme: string, marker: string, lang: string): string {
    const at = readme.indexOf(marker);
    expect(at, marker).toBeGreaterThan(-1);
    const open = readme.indexOf("```" + lang + "\n", at);
    const start = open + lang.length + 4;
    return readme.slice(start, readme.indexOf("```\n", start));
  }

  it("shows the check output, the scaffold output, and the shipped step as they are", async () => {
    const readme = await readFile(path.join(repoRoot, "examples", "todo", "README.md"), "utf8");
    expect(readme).toContain("mv features/steps/complete-todo.ts /tmp/complete-todo.ts.bak\n");
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();
    await rm(path.join(rootDir, "features", "steps", "complete-todo.ts"));

    const checkOut = createCaptureSink();
    const checkCode = await runCli(["check"], { rootDir, stdout: checkOut, stderr: createCaptureSink() });
    expect(checkOut.text()).toBe(blockAfter(readme, "**4.", "text"));
    expect(checkCode).toBe(1);

    const scaffold = blockAfter(readme, "**5. Scaffold it:**", "sh").trim();
    expect(scaffold).toBe('nuka scaffold complete-todo --pattern "the todo titled {title:string} is completed"');
    const scaffoldCode = await runCli(
      ["scaffold", "complete-todo", "--pattern", "the todo titled {title:string} is completed"],
      { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() },
    );
    expect(scaffoldCode).toBe(0);
    const written = await readFile(path.join(rootDir, "features", "steps", "complete-todo.ts"), "utf8");
    expect(written).toBe(blockAfter(readme, "**5. Scaffold it:**", "ts"));

    const shipped = await readFile(path.join(repoRoot, "examples", "todo", "features", "steps", "complete-todo.ts"), "utf8");
    expect(blockAfter(readme, "**6. Implement it.**", "ts")).toBe(shipped);
  });
});
