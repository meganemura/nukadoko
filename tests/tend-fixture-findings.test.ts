import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka tend`'s two new
// findings. `fixture-unused`: `fixtureReachesUnused` (tests/fixtures/
// fixture-touches-browser-project/nukadoko.config.ts) is declared but no
// step requires it. `fixture-touches-app`: `loggedIn` reaches `page`,
// directly — named, never judged (docs/spec.md "Tending": a fact, not a
// verdict; storageState setup is the common legitimate reason).

describe("nuka tend: fixture-unused / fixture-touches-app", () => {
  it("reports both findings, by name, without judging them", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("fixture-touches-browser-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0); // Notes never fail the exit code.
    const report = JSON.parse(stdout.text()) as {
      notes: { code: string; message: string; step?: string; fixture?: string }[];
    };

    const unused = report.notes.find((note) => note.code === "fixture-unused");
    expect(unused).toBeDefined();
    expect(unused?.fixture).toBe("fixtureReachesUnused");
    expect(unused?.step).toBeUndefined();

    const touchesApp = report.notes.find(
      (note) => note.code === "fixture-touches-app" && note.fixture === "loggedIn",
    );
    expect(touchesApp).toBeDefined();
    expect(touchesApp?.step).toBeUndefined();
    expect(touchesApp?.message).toContain("page");

    // Deliberately not a judgment: the
    // message never says to stop, remove, or fix it.
    expect(touchesApp?.message.toLowerCase()).not.toMatch(/\b(stop|remove|fix)\b/);
  });

  it("keeps a step and a fixture of the same name apart in --json", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("fixture-touches-browser-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as {
      notes: { code: string; step?: string; fixture?: string }[];
    };

    const byStep = report.notes.filter((note) => note.step === "loggedIn").map((note) => note.code);
    const byFixture = report.notes.filter((note) => note.fixture === "loggedIn").map((note) => note.code);
    expect(byStep).toEqual(["step-rationale-missing"]);
    expect(byFixture).toEqual(["fixture-touches-app"]);
  });
});
