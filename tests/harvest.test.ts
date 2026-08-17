import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka harvest` end to end against
// tests/fixtures/harvest-project — the eight completion-criteria cases
// docs/spec.md "Harvesting" describes, plus the one integration case that
// closes the loop (a straightforward harvested draft actually passes `nuka
// check`). Two things this file deliberately does not do: it never asserts
// on a second, hand-rolled matching implementation (the round-trip test
// below only checks that a mismatch was *named*, not what src/run/
// match-step.ts itself would have matched, since that would just be this
// test re-deriving the same answer a second way); and it never asserts on
// the exact wording of a stderr/comment message beyond the facts docs/
// spec.md commits to (a step record id, a step name, "does not read
// back") — the prose itself is free to change.

async function doStep(
  rootDir: string,
  name: string,
  argsJson: string,
  extraArgs: readonly string[] = [],
): Promise<{ exitCode: number; record: Record<string, unknown>; stderrText: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["do", name, "--args", argsJson, ...extraArgs], {
    rootDir,
    stdout,
    stderr,
  });
  return { exitCode, record: JSON.parse(stdout.text()), stderrText: stderr.text() };
}

async function harvest(
  rootDir: string,
  stepRecordIds: readonly string[],
): Promise<{ exitCode: number; stdoutText: string; stderrText: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["harvest", ...stepRecordIds], { rootDir, stdout, stderr });
  return { exitCode, stdoutText: stdout.text(), stderrText: stderr.text() };
}

describe("nuka harvest", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("harvest-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("renders a straightforward sequence in line order, every keyword `*`, name placeholders", async () => {
    const create = await doStep(rootDir, "create-project", '{"name":"acme"}');
    const count = await doStep(rootDir, "count-items", '{"count":3}');

    const { exitCode, stdoutText } = await harvest(rootDir, [
      create.record.step_record_id as string,
      count.record.step_record_id as string,
    ]);

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("Feature: (name me)");
    expect(stdoutText).toContain("  Scenario: (name me)");
    const stepLines = stdoutText.split("\n").filter((line) => line.trim().startsWith("*"));
    expect(stepLines).toEqual([
      '    * a project "acme" exists',
      "    * there are 3 items in the cart",
    ]);
    // No keyword other than `*` anywhere — the tool never guesses
    // Given/When/Then (docs/spec.md "Harvesting").
    expect(stdoutText).not.toMatch(/^\s*(Given|When|Then|And|But)\s/m);
  });

  it("a key filled by a used chain does not appear on the line", async () => {
    const create = await doStep(rootDir, "create-project", '{"name":"acme"}');
    const archive = await doStep(rootDir, "archive-project", "{}", [
      "--use",
      create.record.step_record_id as string,
    ]);
    expect(archive.record.args).toEqual({ projectId: "p_acme" });

    const { exitCode, stdoutText } = await harvest(rootDir, [
      create.record.step_record_id as string,
      archive.record.step_record_id as string,
    ]);

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain('* a project "acme" exists');
    expect(stdoutText).toContain("* the project is archived");
    // The chained value itself never lands on the line — it is left to
    // `from`, proven at `nuka check`/`nuka run` time instead.
    expect(stdoutText).not.toContain("p_acme");
  });

  it("a step with no pattern becomes a comment, never a `*` line", async () => {
    const note = await doStep(rootDir, "internal-note", '{"note":"remember this"}');

    const { exitCode, stdoutText, stderrText } = await harvest(rootDir, [note.record.step_record_id as string]);

    expect(exitCode).toBe(0);
    expect(stdoutText).not.toContain("*");
    expect(stdoutText).toContain("#");
    expect(stdoutText).toContain("internal-note");
    expect(stderrText).toContain("internal-note");
  });

  it("a failed record becomes a line, with a comment naming that it failed", async () => {
    const failed = await doStep(rootDir, "always-fails", "{}");
    expect(failed.exitCode).toBe(1);
    expect(failed.record.status).toBe("failed");

    const { exitCode, stdoutText, stderrText } = await harvest(rootDir, [failed.record.step_record_id as string]);

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("* the risky operation runs");
    expect(stdoutText).toMatch(/failed when it ran/);
    expect(stdoutText).toContain("step_error");
    expect(stderrText).toMatch(/failed when it ran/);
  });

  it("a line that does not read back is named, in the draft and on stderr, via nuka run's own matching", async () => {
    const widget = await doStep(rootDir, "flexible-widget", "{}");

    const { exitCode, stdoutText, stderrText } = await harvest(rootDir, [widget.record.step_record_id as string]);

    expect(exitCode).toBe(0);
    // The line is still written (docs/spec.md "Harvesting": a line that
    // does not read back is still a line, only named) — with its own
    // optional/alternation text untouched, since reversing either has no
    // single answer.
    expect(stdoutText).toContain("* a widget(s) is/are created");
    expect(stdoutText).toMatch(/does not read back/);
    expect(stderrText).toMatch(/does not read back/);
  });

  it("a kind: run record is rejected, naming its scenario_record_id, before anything is written", async () => {
    const runStdout = createCaptureSink();
    const runStderr = createCaptureSink();
    const runExit = await runCli(["run", "features/basic.feature"], {
      rootDir,
      stdout: runStdout,
      stderr: runStderr,
    });
    expect(runExit).toBe(0);
    const scenarioRecord = JSON.parse(runStdout.text().trim().split("\n")[0]!);
    const stepRecordId: string = scenarioRecord.steps[0].step_record_id;
    expect(typeof stepRecordId).toBe("string");

    const { exitCode, stdoutText, stderrText } = await harvest(rootDir, [stepRecordId]);

    expect(exitCode).toBe(1);
    expect(stdoutText).toBe("");
    expect(stderrText).toContain(stepRecordId);
    expect(stderrText).toContain(scenarioRecord.scenario_record_id);
  });

  it("provenance lands on stderr only, never on stdout", async () => {
    const create = await doStep(rootDir, "create-project", '{"name":"acme"}');
    const count = await doStep(rootDir, "count-items", '{"count":3}');
    const ids = [create.record.step_record_id as string, count.record.step_record_id as string];

    const { stdoutText, stderrText } = await harvest(rootDir, ids);

    for (const id of ids) {
      expect(stdoutText).not.toContain(id);
      expect(stderrText).toContain(id);
    }
  });

  it("orders lines by each record's own started_at, regardless of the order ids were given on the command line", async () => {
    const create = await doStep(rootDir, "create-project", '{"name":"acme"}');
    const count = await doStep(rootDir, "count-items", '{"count":3}');
    // `create` ran first, `count` second — passing them in the opposite
    // order on the command line must not change the rendered order
    // (docs/spec.md "Harvesting": "the order it actually ran in").
    expect((create.record.started_at as string) <= (count.record.started_at as string)).toBe(true);

    const { exitCode, stdoutText } = await harvest(rootDir, [
      count.record.step_record_id as string,
      create.record.step_record_id as string,
    ]);

    expect(exitCode).toBe(0);
    const createIndex = stdoutText.indexOf('a project "acme" exists');
    const countIndex = stdoutText.indexOf("there are 3 items in the cart");
    expect(createIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeLessThan(countIndex);
  });

  it("a harvested straightforward sequence passes `nuka check` clean, keywords and names untouched", async () => {
    const create = await doStep(rootDir, "create-project", '{"name":"acme"}');
    const count = await doStep(rootDir, "count-items", '{"count":3}');

    const { exitCode: harvestExit, stdoutText } = await harvest(rootDir, [
      create.record.step_record_id as string,
      count.record.step_record_id as string,
    ]);
    expect(harvestExit).toBe(0);

    const draftPath = path.join(rootDir, "features", "harvested.feature");
    await mkdir(path.dirname(draftPath), { recursive: true });
    await writeFile(draftPath, stdoutText, "utf8");

    const checkStdout = createCaptureSink();
    const checkStderr = createCaptureSink();
    const checkExit = await runCli(["check", "features/harvested.feature"], {
      rootDir,
      stdout: checkStdout,
      stderr: checkStderr,
    });

    expect(checkExit).toBe(0);
    expect(checkStdout.text()).toContain("ok: no issues found");
  });

  it("a chain read from a step record outside the given ids is named, not silently blanked", async () => {
    const create = await doStep(rootDir, "create-project", '{"name":"acme"}');
    const archive = await doStep(rootDir, "archive-project", "{}", [
      "--use",
      create.record.step_record_id as string,
    ]);

    // Only the consumer's own id is given — its upstream (create-project)
    // is not among the ids this harvest call was told about, so nothing
    // earlier in the draft could ever supply `projectId` via `from`.
    const { exitCode, stdoutText, stderrText } = await harvest(rootDir, [archive.record.step_record_id as string]);

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("* the project is archived");
    expect(stdoutText).toContain(create.record.step_record_id);
    expect(stderrText).toContain(create.record.step_record_id);
  });

  it("--args overriding one of two same-producer chain keys is not mistaken for a chain read", async () => {
    const create = await doStep(rootDir, "create-project", '{"name":"acme"}');
    // `primaryId` is filled by --use (from create-project's own result);
    // `secondaryId` names the same producer in `from`, but is set directly
    // via --args instead, so `used` still cites create-project even though
    // it never actually supplied secondaryId's own value.
    const link = await doStep(rootDir, "link-projects", '{"secondaryId":"literal-value"}', [
      "--use",
      create.record.step_record_id as string,
    ]);
    expect(link.record.args).toEqual({ primaryId: "p_acme", secondaryId: "literal-value" });
    expect(link.record.used).toEqual([
      { step_record_id: create.record.step_record_id, step: "create-project" },
    ]);

    const { exitCode, stdoutText } = await harvest(rootDir, [
      create.record.step_record_id as string,
      link.record.step_record_id as string,
    ]);

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("* projects are linked");
    // primaryId really was chain-filled: left off the line entirely.
    expect(stdoutText).not.toContain("p_acme");
    // secondaryId was not — its own literal value must still show up
    // somewhere (as a docstring, the one remaining key categorize-args.ts
    // itself never confirmed as a chain read), never silently dropped, and
    // — the fix this test exists to lock in — never mislabeled as a chain
    // read from a record outside this call, since create-project's own id
    // *is* among the given ids.
    expect(stdoutText).toContain("literal-value");
    expect(stdoutText).not.toMatch(/not among the ids given/);
    // The line still does not read back, for an unrelated, genuine reason
    // this fixture deliberately exercises too: `bindStepArgs` itself
    // (src/run/match-step.ts) counts every required schema key not bound
    // by a named capture as "unconsumed" when deciding whether a table/
    // docstring can bind at all — it does not know about `from` — so a
    // step that leaves one key to chain and needs an attachment for
    // another can never bind on a real `nuka run` either. The round trip
    // catching that is correct: it is what stops harvest from asserting a
    // line "reads back" when nukadoko's own binding rule would refuse it.
    expect(stdoutText).toMatch(/does not read back/);
    expect(stdoutText).toContain("left unconsumed");
  });

  it("a docstring fills the one required key a capture left unconsumed, and the line reads back", async () => {
    const note = await doStep(rootDir, "set-note", '{"projectId":"p_acme","note":"handle with care"}');

    const { exitCode, stdoutText } = await harvest(rootDir, [note.record.step_record_id as string]);

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain('* a note is set for project "p_acme"');
    expect(stdoutText).toContain('"""');
    expect(stdoutText).toContain("handle with care");
    expect(stdoutText).not.toMatch(/does not read back/);
  });

  it("a required key with no capture, no chain, and no docstring/table shape is named as unfillable", async () => {
    const priority = await doStep(rootDir, "set-priority", '{"projectId":"p_acme","priority":2}');

    const { exitCode, stdoutText, stderrText } = await harvest(rootDir, [priority.record.step_record_id as string]);

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain('* a priority is set for project "p_acme"');
    expect(stdoutText).toContain("unfillable-required-key");
    expect(stdoutText).toContain("priority");
    expect(stderrText).toContain("unfillable-required-key");
  });

  it("a table fills the one required key a capture left unconsumed, and the line reads back", async () => {
    const rows = await doStep(rootDir, "import-rows", '{"projectId":"p_acme","rows":[["a","b"],["c","d"]]}');

    const { exitCode, stdoutText } = await harvest(rootDir, [rows.record.step_record_id as string]);

    expect(exitCode).toBe(0);
    expect(stdoutText).toContain('* rows are imported for project "p_acme"');
    expect(stdoutText).toMatch(/\|\s*a\s*\|\s*b\s*\|/);
    expect(stdoutText).not.toMatch(/does not read back/);
  });
});
