import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { runHarvest } from "../src/cli/harvest.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka harvest`'s own setup-phase refusals. harvest.test.ts
// covers the eight completion-criteria cases docs/spec.md "Harvesting"
// describes plus the `kind: "run"` refusal, but never a bad id, a
// config/discovery failure, or zero ids (yargs' own `demandOption` on
// `<step-record-ids..>` refuses an empty invocation before `runHarvest` is
// ever called, so that one case is only reachable by importing `runHarvest`
// directly, exactly the reason cli/harvest.ts's own header gives for
// keeping this logic out of run-cli.ts: "unit-testable without going
// through yargs").

describe("nuka harvest: bad ids", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("harvest-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses on an unknown step record id, naming it, before writing anything", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["harvest", "does-not-exist"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no such step record: does-not-exist");
  });

  it("reports every bad id given, not just the first", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["harvest", "bad-one", "bad-two"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no such step record: bad-one");
    expect(stderr.text()).toContain("no such step record: bad-two");
  });
});

describe("nuka harvest: setup-phase config/discovery failures", () => {
  it("propagates a config load failure as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["harvest", "whatever"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("typo");
  });

  it("propagates a step discovery failure (a broken glue file) as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["harvest", "whatever"], {
      rootDir: fixture("discover-import-failure-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("require is not defined");
  });
});

describe("nuka harvest: zero ids (only reachable below yargs' own demandOption)", () => {
  it("refuses with no ids given, writing nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runHarvest({
      rootDir: fixture("harvest-project"),
      stepRecordIds: [],
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("nuka harvest needs at least one step record id");
  });
});
