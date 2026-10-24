import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: the notes of a whole-project `nuka check`. One fixture
// carries a note of each step-level kind, each paired with a healthy step
// that exercises the same mechanism, so a false positive on the healthy step
// fails as loudly as a missed note on the unhealthy one.

async function check(args: readonly string[], rootDir: string) {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["check", ...args], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe("nuka check notes", () => {
  it("reports no note for a project whose vocabulary and bindings are clean", async () => {
    const { exitCode, stdout, stderr } = await check(["--json"], fixture("check-notes-clean-project"));
    expect(stderr).toBe("");
    const report = bySeverity(stdout);
    expect(report.errors).toEqual([]);
    expect(report.notes).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("detects every note this fixture holds, and exits 0 because notes never fail the check", async () => {
    const { exitCode, stdout, stderr } = await check(["--json"], fixture("check-notes-project"));
    expect(stderr).toBe("");
    const report = bySeverity(stdout);
    expect(report.errors).toEqual([]);
    expect(exitCode).toBe(0);
    const codes = report.notes.map((issue: { code: string }) => issue.code).sort();
    expect(codes).toEqual(["from-unused", "pattern-unbound", "schema-field-undescribed", "parameter-type-unused"].sort());
  });

  it("turns a note into exit 1 with --fail-on, and the finding stays a note", async () => {
    const { exitCode, stdout, stderr } = await check(["--fail-on", "pattern-unbound"], fixture("check-notes-project"));
    expect(exitCode).toBe(1);
    expect(stderr).toBe("fail-on: pattern-unbound reported 1 finding\n");
    expect(stdout).toMatch(/^note\tpattern-unbound\tfeatures\/steps\/unbound-step\.ts\t/m);
  });

  it("computes no note when targets select the features, since a note is a fact about the whole project", async () => {
    const { exitCode, stdout } = await check(["--json", "features/notes.feature"], fixture("check-notes-project"));
    expect(exitCode).toBe(0);
    expect(bySeverity(stdout).notes).toEqual([]);
  });

  it("from-unused: fires only for the step whose pattern always captures the from key, not the step that genuinely relies on from", async () => {
    const report = bySeverity((await check(["--json"], fixture("check-notes-project"))).stdout);
    const fromUnused = report.notes.filter((issue: { code: string }) => issue.code === "from-unused");
    expect(fromUnused).toHaveLength(1);
    expect(fromUnused[0].step).toBe("orphan-from-step");
    expect(fromUnused[0].message).toContain("from.id");
    // States the fact, not a verdict: the message may discuss removal only
    // to say it is *not* prescribing it, never as an instruction.
    expect(fromUnused[0].message).toContain("not a verdict");
    expect(fromUnused[0].message).not.toMatch(/^(remove|delete)/i);
    const steps = report.notes.map((issue: { step?: string }) => issue.step);
    expect(steps).not.toContain("chained-note-step");
  });

  it("pattern-unbound: fires only for the unbound typed step, never for the compat step no feature binds either, and names the scanned directories", async () => {
    const report = bySeverity((await check(["--json"], fixture("check-notes-project"))).stdout);
    const unbound = report.notes.filter((issue: { code: string }) => issue.code === "pattern-unbound");
    expect(unbound).toHaveLength(1);
    expect(unbound[0].step).toBe("unbound-step");
    expect(unbound[0].message).toContain("under the scanned directories (features)");
    const messages = report.notes.map((issue: { message: string }) => issue.message).join("\n");
    expect(messages).not.toContain("a compat thing that nobody calls happens");
    expect(messages).not.toContain("compat:");
  });

  it("schema-field-undescribed: names the missing field, not the described one", async () => {
    const report = bySeverity((await check(["--json"], fixture("check-notes-project"))).stdout);
    const undescribed = report.notes.filter((issue: { code: string }) => issue.code === "schema-field-undescribed");
    expect(undescribed).toHaveLength(1);
    expect(undescribed[0].step).toBe("undescribed-field-step");
    expect(undescribed[0].message).toContain("args.label");
    expect(undescribed[0].message).not.toContain("returns.filed");
    const steps = report.notes.map((issue: { step?: string }) => issue.step);
    expect(steps).not.toContain("create-widget");
  });

  it("parameter-type-unused: fires only for the entry no typed or compat pattern references, on the config file", async () => {
    const report = bySeverity((await check(["--json"], fixture("check-notes-project"))).stdout);
    const unused = report.notes.filter((issue: { code: string }) => issue.code === "parameter-type-unused");
    expect(unused).toHaveLength(1);
    expect(unused[0].message).toContain("ghost-type");
    expect(unused[0].message).not.toContain("used-type");
    expect(unused[0].file).toBe("nukadoko.config.ts");
  });

  it("every note has a stable kebab-case code, a message, and a fix", async () => {
    const report = bySeverity((await check(["--json"], fixture("check-notes-project"))).stdout);
    for (const issue of report.notes) {
      expect(issue.code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.fix.length).toBeGreaterThan(0);
    }
  });

  it("prints errors, then warnings, then notes, one line each followed by its fix or do line, when --json is omitted", async () => {
    const { exitCode, stdout } = await check([], fixture("check-notes-project"));
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    const findingLines = lines.filter((_, index) => index % 2 === 0);
    const hintLines = lines.filter((_, index) => index % 2 === 1);
    const severities = findingLines.map((line) => line.split("\t")[0]);
    expect(severities).toEqual(["warning", "note", "note", "note", "note"]);
    for (const line of hintLines) {
      expect(line).toMatch(/^  (fix|do): \S/);
    }
    expect(stdout).not.toContain("ok: no issues found");
  });

});
