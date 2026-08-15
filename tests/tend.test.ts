import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

describe("nuka tend", () => {
  it("reports zero errors and zero notes for a healthy project", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("tend-clean-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text());
    // Checked field by field, not via a single `toEqual(report)` (m8a's
    // original assertion here): `report` now always carries a `summary`
    // too (asserted on its own below), and a
    // whole-object equality would make this test couple to that field's
    // exact shape for no reason this test cares about.
    expect(report.errors).toEqual([]);
    expect(report.notes).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("summary: a typed-only project reports compat 0, and every declared number fully satisfied", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("tend-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    // "typed 12, compat 0" is itself useful — migration is done — so the
    // migration line is present even though this fixture has no compat step
    // at all.
    expect(report.summary.typedSteps).toBe(2);
    expect(report.summary.compatSteps).toBe(0);
    expect(report.summary.compatStepNames).toEqual([]);
    // Every typed step in this fixture carries a rationale, and every
    // args/returns field carries a .describe() (tests/fixtures/tend-clean-
    // project's own step files) — declared === total on both.
    expect(report.summary.rationale).toEqual({ declared: 2, total: 2 });
    expect(report.summary.describe).toEqual({ declared: 5, total: 5 });
    // fb3-scan-dirs: featuresDir alone, since this fixture sets no
    // additionalFeatureDirs (schema default `[]`), and every step here
    // defaults to `mutates: true` (define-step.ts's own `?? true`).
    expect(report.summary.scannedFeatureDirs).toEqual(["features"]);
    expect(report.summary.readOnlySteps).toBe(0);
    // A summary-only report (zero errors, zero notes) still exits 0 — the
    // summary itself never touches the exit code.
    expect(report.errors).toEqual([]);
    expect(report.notes).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("summary: a mid-migration project reports both typed and compat counts, and names each compat step", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    // tests/fixtures/tend-findings-project has 7 typed step files and
    // features/steps/compat-glue.ts's 2 Given() registrations.
    expect(report.summary.typedSteps).toBe(7);
    expect(report.summary.compatSteps).toBe(2);
    expect(report.summary.compatStepNames.slice().sort()).toEqual(
      ["compat: a compat thing that nobody calls happens", "compat: a shout {used-type} is heard"].sort(),
    );
  });

  it("summary: rationale and describe coverage counts match this task's fixture exactly, not just non-zero", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    // Of 7 typed steps, only no-rationale-step.ts omits `rationale`.
    expect(report.summary.rationale).toEqual({ declared: 6, total: 7 });
    // Of the 15 args/returns fields across all 7 typed steps, only
    // undescribed-field-step.ts's `args.label` has no .describe() — the
    // same fact tests/tend.test.ts's own schema-field-undescribed test
    // already checks by name, counted here rather than re-derived.
    expect(report.summary.describe).toEqual({ declared: 14, total: 15 });
  });

  it("prints a human-readable ok line when there is nothing to tend", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend"], {
      rootDir: fixture("tend-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("ok: nothing to tend");
  });

  it("detects all five findings, and exits 0 because errors stay empty (notes never fail the run)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text());
    expect(report.errors).toEqual([]);
    expect(exitCode).toBe(0);

    const codes = report.notes.map((issue: { code: string }) => issue.code).sort();
    expect(codes).toEqual(
      [
        "from-unused",
        "pattern-unbound",
        "schema-field-undescribed",
        "step-rationale-missing",
        "parameter-type-unused",
      ].sort(),
    );
  });

  it("from-unused: fires only for the step whose pattern always captures the from key, not the step that genuinely relies on from", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    const fromUnused = report.notes.filter((issue: { code: string }) => issue.code === "from-unused");
    expect(fromUnused).toHaveLength(1);
    expect(fromUnused[0].step).toBe("orphan-from-step");
    expect(fromUnused[0].message).toContain("from.id");
    // States the fact, not a verdict (never says "delete it") — the
    // message may discuss removal only to say it is *not*
    // prescribing it, never as an instruction.
    expect(fromUnused[0].message).toContain("not a verdict");
    expect(fromUnused[0].message).not.toMatch(/^(remove|delete)/i);

    const steps = report.notes.map((issue: { step?: string }) => issue.step);
    expect(steps).not.toContain("chained-note-step");
  });

  it("pattern-unbound: fires only for the unbound typed step, never for the compat step no feature binds either", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    const unbound = report.notes.filter((issue: { code: string }) => issue.code === "pattern-unbound");
    expect(unbound).toHaveLength(1);
    expect(unbound[0].step).toBe("unbound-step");

    const messages = report.notes.map((issue: { message: string }) => issue.message).join("\n");
    expect(messages).not.toContain("a compat thing that nobody calls happens");
    expect(messages).not.toContain("compat:");
  });

  it("schema-field-undescribed: names the missing field, not the described one", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    const undescribed = report.notes.filter(
      (issue: { code: string }) => issue.code === "schema-field-undescribed",
    );
    expect(undescribed).toHaveLength(1);
    expect(undescribed[0].step).toBe("undescribed-field-step");
    expect(undescribed[0].message).toContain("args.label");
    expect(undescribed[0].message).not.toContain("returns.filed");

    const steps = report.notes.map((issue: { step?: string }) => issue.step);
    expect(steps).not.toContain("create-widget");
  });

  it("step-rationale-missing: fires only for the step with no rationale", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    const missing = report.notes.filter((issue: { code: string }) => issue.code === "step-rationale-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].step).toBe("no-rationale-step");

    const steps = report.notes.map((issue: { step?: string }) => issue.step);
    expect(steps).not.toContain("create-widget");
    expect(steps).not.toContain("log-note");
  });

  it("parameter-type-unused: fires only for the entry no typed or compat pattern references", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    const unused = report.notes.filter((issue: { code: string }) => issue.code === "parameter-type-unused");
    expect(unused).toHaveLength(1);
    expect(unused[0].message).toContain("ghost-type");
    expect(unused[0].message).not.toContain("used-type");
  });

  it("every note has a stable kebab-case code and a message", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());

    for (const issue of [...report.errors, ...report.notes]) {
      expect(issue.code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it("prints one human-readable line per note, grouped by kind, when --json is omitted", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend"], {
      rootDir: fixture("tend-findings-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const allLines = stdout.text().trim().split("\n");
    // The summary (now three lines since
    // fb3-scan-dirs's own `scanned:` line) prints first, and is visually
    // distinct from a finding line: no leading `error\t`/`note\t`.
    const summaryLines = allLines.slice(0, 3);
    const noteLines = allLines.slice(3);
    for (const line of summaryLines) {
      expect(line).not.toMatch(/^(error|note)\t/);
    }

    expect(noteLines).toHaveLength(5);
    for (const line of noteLines) {
      expect(line).toMatch(/^note\t/);
    }
    // Grouped by kind: same code's lines (there is at most one per code in
    // this fixture) sit together, which — for a single-occurrence-per-code
    // fixture — just means the codes column has no duplicate reappearing
    // after a different code interrupts it.
    const codes = noteLines.map((line) => line.split("\t")[1]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("prints the summary before findings, and before the 'nothing to tend' line on a healthy project", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend"], {
      rootDir: fixture("tend-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const lines = stdout.text().trim().split("\n");
    expect(lines).toEqual([
      "scanned: features",
      "bed: typed 2, compat 0, read-only 0",
      "declared: rationale 2/2, describe 5/5",
      "ok: nothing to tend",
    ]);
  });

  it("propagates a config error as stderr + exit 1, no report on stdout", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("typo");
  });
});
