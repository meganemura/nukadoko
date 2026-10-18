import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `step-description-todo`, the default `nuka tend` note for
// a step whose description is still the TODO `nuka scaffold` wrote. A step
// scaffolded with `--description`, or one whose description was edited,
// gets no note, and `--fail-on` turns the note into a failing exit.

async function cli(rootDir: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe("nuka tend: step-description-todo", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    expect((await cli(rootDir, ["init"])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("notes a scaffolded step whose description is still the TODO, with its file, and exits 0", async () => {
    expect((await cli(rootDir, ["scaffold", "send-invite"])).exitCode).toBe(0);

    const tend = await cli(rootDir, ["tend"]);

    expect(tend.stdout).toContain(
      'note\tstep-description-todo\tfeatures/steps/send-invite.ts\tStep "send-invite" still has the description nuka scaffold wrote ("TODO: describe send-invite"); nuka steps and nuka describe show it to whoever picks a step, so say what the step does.\n',
    );
    expect(tend.exitCode).toBe(0);

    const json = await cli(rootDir, ["tend", "--json"]);
    expect(bySeverity(json.stdout).notes).toEqual([
      expect.objectContaining({ code: "step-description-todo", file: "features/steps/send-invite.ts", step: "send-invite" }),
    ]);
  });

  it("does not note a step scaffolded with --description, or one whose description was edited", async () => {
    expect((await cli(rootDir, ["scaffold", "send-invite", "--description", "Send an invitation email"])).exitCode).toBe(0);
    expect((await cli(rootDir, ["scaffold", "accept-invite"])).exitCode).toBe(0);
    const file = path.join(rootDir, "features", "steps", "accept-invite.ts");
    await writeFile(file, (await readFile(file, "utf8")).replace("TODO: describe accept-invite", "Accept the invitation"));

    const tend = await cli(rootDir, ["tend", "--json"]);

    expect(bySeverity(tend.stdout).notes.map((note: { code: string }) => note.code)).not.toContain("step-description-todo");
    expect(tend.exitCode).toBe(0);
  });

  it("exits 1 under --fail-on step-description-todo while the TODO is there", async () => {
    expect((await cli(rootDir, ["scaffold", "send-invite"])).exitCode).toBe(0);

    const tend = await cli(rootDir, ["tend", "--fail-on", "step-description-todo"]);

    expect(tend.stderr).toContain("fail-on: step-description-todo reported 1 finding\n");
    expect(tend.exitCode).toBe(1);
  });
});
