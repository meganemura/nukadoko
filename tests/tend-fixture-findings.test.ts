import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `fixture-unused`: `fixtureReachesUnused` (tests/fixtures/
// fixture-touches-browser-project/nukadoko.config.ts) is declared but no
// step requires it, and the note names the fixture, not a step.

describe("nuka tend: fixture-unused", () => {
  it("names the fixture no step requires", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("fixture-touches-browser-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0); // Notes never fail the exit code.
    const report = bySeverity(stdout.text()) as {
      notes: { code: string; message: string; step?: string; fixture?: string }[];
    };

    const unused = report.notes.find((note) => note.code === "fixture-unused");
    expect(unused).toBeDefined();
    expect(unused?.fixture).toBe("fixtureReachesUnused");
    expect(unused?.step).toBeUndefined();
    expect(report.notes.filter((note) => note.code === "fixture-unused").map((note) => note.fixture)).toEqual([
      "fixtureReachesUnused",
    ]);
  });

  it("keeps a step and a fixture of the same name apart in --json", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("fixture-touches-browser-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const report = bySeverity(stdout.text()) as {
      notes: { code: string; step?: string; fixture?: string }[];
    };

    const byStep = report.notes.filter((note) => note.step === "loggedIn").map((note) => note.code);
    const byFixture = report.notes.filter((note) => note.fixture === "loggedIn").map((note) => note.code);
    expect(byStep).toEqual(["pattern-unbound"]);
    expect(byFixture).toEqual([]);
  });
});
