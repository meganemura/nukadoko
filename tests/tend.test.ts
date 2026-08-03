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
    expect(report).toEqual({ errors: [], notes: [] });
    expect(exitCode).toBe(0);
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
    // States the fact, not a verdict (this task's spec: "「消せ」と言わない
    // こと") — the message may discuss removal only to say it is *not*
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
    const lines = stdout.text().trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).toMatch(/^note\t/);
    }
    // Grouped by kind: same code's lines (there is at most one per code in
    // this fixture) sit together, which — for a single-occurrence-per-code
    // fixture — just means the codes column has no duplicate reappearing
    // after a different code interrupts it.
    const codes = lines.map((line) => line.split("\t")[1]);
    expect(new Set(codes).size).toBe(codes.length);
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
