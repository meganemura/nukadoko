import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka tend`'s sign-off-rot finding end to end — the one
// tend finding that is an `error`, not a
// note (docs/spec.md "Tending"). Every corrupting edit here is applied
// *after* a real `nuka run` + `nuka accept` cycle against
// tend-signoff-project, never a hand-assembled record: src/accept/
// render-record.ts is the only writer of the record format, and hand-
// rolling one here would risk testing this finding against a shape it
// never actually produces (this task's own "誤検出ゼロ" constraint — the
// (b) comparison in particular only means anything against a record the
// real writer produced).

interface Report {
  errors: { code: string; message: string; file?: string; step?: string }[];
  notes: { code: string }[];
}

async function runTend(rootDir: string): Promise<{ report: Report; exitCode: number }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  return { report: JSON.parse(stdout.text()) as Report, exitCode };
}

describe("nuka tend: sign-off rot", () => {
  let rootDir: string;
  let featuresDir: string;
  let recordPath: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("tend-signoff-project");
    featuresDir = path.join(rootDir, "features");
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/checkout.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const acceptStdout = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/checkout.feature"], {
      rootDir,
      stdout: acceptStdout,
      stderr: createCaptureSink(),
    });
    expect(acceptExit).toBe(0);
    recordPath = acceptStdout.text().trim();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports nothing for a freshly accepted, untouched record — including its compat step's result: null", async () => {
    const content = await readFile(path.join(rootDir, recordPath), "utf8");
    // Proves the fixture actually exercises the compat skip this test
    // claims to prove, rather than the assertion below passing vacuously.
    expect(content).toContain('"step": "compat: a legacy discount is applied"');
    expect(content).toContain('"result": null');

    const { report, exitCode } = await runTend(rootDir);
    expect(report.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("(a) reports the record's own feature as missing once the feature file is deleted", async () => {
    await rm(path.join(featuresDir, "checkout.feature"));

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(1);

    const missing = report.errors.filter((e) => e.code === "signoff-feature-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.file).toBe(recordPath);
    expect(missing[0]!.message).toContain("features/checkout.feature");
    expect(missing[0]!.message).not.toMatch(/hand-edit|edit the record/i);
  });

  it("(b) reports the frozen feature source as stale once the feature file changes", async () => {
    const original = await readFile(path.join(featuresDir, "checkout.feature"), "utf8");
    await writeFile(path.join(featuresDir, "checkout.feature"), original.replace("a shopper checks out", "a shopper checks out twice"));

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(1);

    const changed = report.errors.filter((e) => e.code === "signoff-feature-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.file).toBe(recordPath);
  });

  it("(c) reports a cited step as missing once its step file is deleted from the vocabulary", async () => {
    await rm(path.join(featuresDir, "steps", "cart-total.ts"));

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(1);

    const missing = report.errors.filter((e) => e.code === "signoff-step-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.file).toBe(recordPath);
    expect(missing[0]!.step).toBe("cart-total");
  });

  it("(d) reports a frozen result as invalid once the step's returns schema tightens", async () => {
    const stepPath = path.join(featuresDir, "steps", "cart-total.ts");
    const original = await readFile(stepPath, "utf8");
    await writeFile(
      stepPath,
      original.replace(
        "returns: z.object({ total: z.string() }),",
        "returns: z.object({ total: z.string(), currency: z.string() }),",
      ),
    );

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(1);

    const invalid = report.errors.filter((e) => e.code === "signoff-result-invalid");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.file).toBe(recordPath);
    expect(invalid[0]!.step).toBe("cart-total");
    expect(invalid[0]!.message).toContain("currency");
    expect(invalid[0]!.message).not.toMatch(/hand-edit|edit the record/i);
  });

  it("reports a record written before record_id existed as old-format, telling the reader to re-run and re-accept, and skips its other checks", async () => {
    // No migration code is written for this (the user re-runs and
    // re-accepts). This test stands in for that older tool version by taking
    // a record `nuka accept` really produced and removing the one field
    // every step record it now writes always carries — the same fact
    // `findSignoffRot`'s own detection tests for — rather than hand-rolling
    // a record shape this codebase's own writer never produces.
    const original = await readFile(path.join(rootDir, recordPath), "utf8");
    const withoutRecordIds = original.replace(/```json\n([\s\S]*?)\n```/g, (block, jsonText: string) => {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      if (!("record_id" in parsed)) return block; // A hook's own JSON block never had one.
      delete parsed.record_id;
      return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    });
    expect(withoutRecordIds).not.toBe(original); // Proves the fixture's record actually had step blocks to strip.
    await writeFile(path.join(rootDir, recordPath), withoutRecordIds);

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(1);

    expect(report.errors).toHaveLength(1);
    const oldFormat = report.errors[0]!;
    expect(oldFormat.code).toBe("signoff-record-old-format");
    expect(oldFormat.file).toBe(recordPath);
    expect(oldFormat.message).toMatch(/nuka run/);
    expect(oldFormat.message).toMatch(/nuka accept/);
  });

  it("reports an unparseable record as an error, naming the file, without touching the healthy one", async () => {
    await writeFile(
      path.join(featuresDir, "broken.2026-01-01-abc1234.md"),
      ["---", "run_id: run-x", "commit: abc1234", "feature: features/checkout.feature", "scenarios:", "  - name: nope", "---", "", "no gherkin fence here at all"].join("\n"),
    );

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.code).toBe("signoff-record-unreadable");
    expect(report.errors[0]!.file).toBe("features/broken.2026-01-01-abc1234.md");
  });

  it("does not mistake an ordinary Markdown file for a record", async () => {
    await writeFile(path.join(rootDir, "README.md"), "# Just a readme\n\nNothing to see here.\n");

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("does not walk into node_modules, even for a record-shaped file that would otherwise report an error", async () => {
    const fakePkgDir = path.join(rootDir, "node_modules", "some-package");
    await mkdir(fakePkgDir, { recursive: true });
    await writeFile(
      path.join(fakePkgDir, "RECORD.md"),
      [
        "---",
        "run_id: run-x",
        "commit: abc1234",
        "feature: features/does-not-exist.feature",
        "scenarios:",
        "  - name: nope",
        "---",
        "",
        "## The scenario as it ran",
        "",
        "```gherkin",
        "Feature: x",
        "```",
      ].join("\n"),
    );

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(0);
    expect(report.errors).toEqual([]);
  });
});
