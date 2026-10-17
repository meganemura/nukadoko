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
// `--use` and `--fail-on` are arrays on purpose and stay repeatable.
// A boolean given twice stays that boolean.

const REPEATED: ReadonlyArray<{ readonly flag: string; readonly argv: readonly string[]; readonly help: string }> = [
  { flag: "--base-url", argv: ["init", "--base-url", "http://a", "--base-url", "http://b"], help: "nuka init --help" },
  { flag: "--features-dir", argv: ["init", "--features-dir", "e2e", "--features-dir", "specs"], help: "nuka init --help" },
  { flag: "--session", argv: ["run", "features/x.feature", "--session", "a", "--session", "b"], help: "nuka run --help" },
  { flag: "--env", argv: ["run", "features/x.feature", "--env", "a", "--env", "b"], help: "nuka run --help" },
  { flag: "--concurrency", argv: ["run", "features/x.feature", "--concurrency", "2", "--concurrency", "3"], help: "nuka run --help" },
  { flag: "--repeat", argv: ["run", "features/x.feature", "--repeat", "2", "--repeat", "3"], help: "nuka run --help" },
  { flag: "--args", argv: ["do", "step", "--args", "{}", "--args", "{}"], help: "nuka do --help" },
  { flag: "--session", argv: ["do", "step", "--args", "{}", "--session", "a", "--session", "b"], help: "nuka do --help" },
  { flag: "--env", argv: ["do", "step", "--args", "{}", "--env", "a", "--env", "b"], help: "nuka do --help" },
  { flag: "--env", argv: ["session", "clear", "--env", "a", "--env", "b"], help: "nuka session clear --help" },
  { flag: "--env", argv: ["session", "start", "s", "--env", "a", "--env", "b"], help: "nuka session start --help" },
  { flag: "--idle-timeout", argv: ["session", "start", "s", "--idle-timeout", "1", "--idle-timeout", "2"], help: "nuka session start --help" },
  { flag: "--env", argv: ["session", "stop", "s", "--env", "a", "--env", "b"], help: "nuka session stop --help" },
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
    expect(stderr.text()).toBe(`${flag} was given more than once.\ndo: ${help}\n`);
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
    expect(withoutNoConfigLine(stderr.text())).toBe("Unknown step: step\ndo: nuka steps\n");
  });

  it("keeps every --fail-on value", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["tend", "--fail-on", "a", "--fail-on", "b"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(withoutNoConfigLine(stderr.text()).startsWith('--fail-on: "a", "b" are not codes nuka tend reports.')).toBe(true);
  });

  it("treats a repeated boolean as that boolean", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["steps", "--json", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(withoutNoConfigLine(stderr.text())).toBe("");
    expect(JSON.parse(stdout.text())).toEqual({
      schema_version: 1,
      error: `featuresDir "features" does not exist at ${path.join(rootDir, "features")}`,
      do: "nuka steps --help",
    });
  });
});
