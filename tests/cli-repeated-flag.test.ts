import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  removeTempDir,
  withoutNoConfigLine,
} from "./helpers/fixtures.js";

// Responsibility: a string or number flag that takes one value must be
// refused when it is given again, before the command writes anything.
// `--use` and `--fail-on` are arrays on purpose and stay repeatable, and so
// is `nuka run --env`, which runs once per environment it names.
// A boolean given twice stays that boolean.

const REPEATED: ReadonlyArray<{ readonly flag: string; readonly argv: readonly string[]; readonly help: string }> = [
  { flag: "--concurrency", argv: ["run", "features/x.feature", "--concurrency", "2", "--concurrency", "3"], help: "nuka run --help" },
  { flag: "--repeat", argv: ["run", "features/x.feature", "--repeat", "2", "--repeat", "3"], help: "nuka run --help" },
  { flag: "--args", argv: ["do", "step", "--args", "{}", "--args", "{}"], help: "nuka do --help" },
  { flag: "--env", argv: ["do", "step", "--args", "{}", "--env", "a", "--env", "b"], help: "nuka do --help" },
  { flag: "--pattern", argv: ["scaffold", "step", "--pattern", "a", "--pattern", "b"], help: "nuka scaffold --help" },
];

describe("repeated singular flags", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it.each(REPEATED)("refuses a second $flag and writes nothing ($argv)", async ({ flag, argv, help }) => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli([...argv], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe(
      `refused\tinvalid-arguments\t-\t${flag} was given more than once.\n  fix: Correct the command line; the command's --help lists its flags.\n  do: ${help}\n`,
    );
    expect(stdout.text()).toBe("");
    expect(readdirSync(rootDir)).toEqual([]);
  });

  it("keeps every --use value", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    mkdirSync(path.join(rootDir, "features"));

    const exitCode = await runCli(["do", "step", "--use", "r1", "--use", "r2"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(withoutNoConfigLine(stderr.text())).toBe("refused\tunknown-step\t-\tUnknown step: step\n  fix: Name a step that nuka steps lists.\n  do: nuka steps\n");
  });

  it("keeps every --fail-on value", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["check", "--fail-on", "a", "--fail-on", "b"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(withoutNoConfigLine(stderr.text())).toBe('refused\tfail-on-unknown-code\t-\t--fail-on: "a", "b" are not codes nuka check reports\n  fix: Name an error, warning, or note code that nuka check --codes lists.\n  do: nuka check --codes\n');
  });

  it("treats a repeated boolean as that boolean", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["steps", "--json", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(withoutNoConfigLine(stderr.text())).toBe("");
    expect(JSON.parse(stdout.text()).findings[1]).toEqual({
      severity: "refused",
      code: "features-dir-missing",
      message: `featuresDir "features" does not exist at ${path.join(rootDir, "features")}`,
      fix: "Create the featuresDir directory, or correct featuresDir in the config file.",
      do: "nuka steps --help",
    });
  });
});
