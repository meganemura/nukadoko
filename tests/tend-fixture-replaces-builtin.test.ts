import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { BUILTIN_FIXTURE_NAMES } from "../src/step/context.js";
import { findFixturesReplacingBuiltins } from "../src/tend/fixture-replaces-builtin.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

type Note = { code: string; file?: string; fixture?: string; step?: string; message: string; do: string };

async function tendNotes(rootDir: string, code: string): Promise<{ exitCode: number; notes: Note[] }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  const report = bySeverity(stdout.text()) as { notes: Note[] };
  return { exitCode, notes: report.notes.filter((note) => note.code === code) };
}

describe("nuka tend: fixture-replaces-builtin", () => {
  it("names a config.fixtures entry called scratch, with what the builtin gives", async () => {
    const { exitCode, notes } = await tendNotes(fixture("scratch-override-project"), "fixture-replaces-builtin");

    expect(notes).toEqual([
      {
        code: "fixture-replaces-builtin",
        fixture: "scratch",
        file: "nukadoko.config.ts",
        message:
          'Fixture "scratch" in config.fixtures replaces nukadoko\'s builtin scratch fixture, which gives scratch.dir(prefix) and scratch.copy(source), each a new temporary directory that is removed when the scenario ends and listed in the step record\'s evidence.scratch.',
        fix: "Delete the scratch fixture from config.fixtures, and its StepFixtures declaration, if the builtin covers what it does; keep both if the project needs its own shape.",
      },
    ]);
    expect(exitCode).toBe(0);
  });

  it("says nothing when the project uses the builtin", async () => {
    const { notes } = await tendNotes(fixture("scratch-project"), "fixture-replaces-builtin");
    expect(notes).toEqual([]);
  });

  it("reports each scratch entry and no other name, in config order", () => {
    hegel.test((tc) => {
      const names = tc.draw(
        gs.arrays(
          gs.oneOf(
            gs.sampledFrom([...BUILTIN_FIXTURE_NAMES, "constructor", "toString", "__proto__"]),
            gs.text({ minSize: 1, maxSize: 8, alphabet: "abcdefghijklmnopqrstuvwxyz" }),
          ),
          { maxSize: 6 },
        ),
      );
      expect(findFixturesReplacingBuiltins(names).map((issue) => issue.fixture)).toEqual(
        names.filter((name) => name === "scratch"),
      );
    });
  });
});
