import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readOwnVersion } from "../src/version.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

describe("nuka check", () => {
  it("exits 0 with zero errors and zero warnings for a clean project", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toEqual({
      schema_version: 2,
      nukadoko: readOwnVersion(),
      command: "check",
      verdict: "passed",
      findings: [],
    });
    expect(exitCode).toBe(0);
  });

  it("prints a human-readable ok line when there is nothing to report", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("ok: no issues found");
  });

  it("exits 0 with warnings only: env-file-missing, environment-env-file-missing, then-mutates", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-warnings-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "env-file-missing",
          fix: 'Create .env.missing, or remove ".env.missing" from envFiles in nukadoko.config.ts.',
        }),
        expect.objectContaining({
          code: "environment-env-file-missing",
          fix: 'Create .env.staging-missing, or remove ".env.staging-missing" from environments.staging.envFiles in nukadoko.config.ts.',
        }),
        expect.objectContaining({ code: "then-mutates" }),
      ]),
    );
    // secrets-public-key-unknown moved to `nuka tend` — this fixture's
    // config still names an undefined
    // secrets.public key (tests/tend-moved-findings.test.ts's own fixture
    // reuse), but `check` no longer reports it.
    expect(report.warnings.some((issue: { code: string }) => issue.code === "secrets-public-key-unknown")).toBe(
      false,
    );
    expect(report.warnings).toHaveLength(3);
    expect(exitCode).toBe(0);
  });

  it("then-mutates is a warning (declaration/position tension), not an error: check still exits 0", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-warnings-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const thenMutates = report.warnings.find(
      (issue: { code: string }) => issue.code === "then-mutates",
    );
    expect(thenMutates).toBeDefined();
    expect(thenMutates.message).toContain("bound in Then position");
    expect(thenMutates.message).toContain("tension");
    expect(exitCode).toBe(0);
  });

  it("exits 1 reporting features-dir-missing as an error when featuresDir doesn't exist", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-features-dir-missing-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    expect(report.errors).toEqual([expect.objectContaining({ code: "features-dir-missing" })]);
    expect(exitCode).toBe(1);
  });

  it("names a featuresDir or additionalFeatureDirs path with a space in its fix", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-check-spaced-dirs-"));
    try {
      await writeFile(
        path.join(rootDir, "nukadoko.config.ts"),
        'export default { featuresDir: "my features", additionalFeatureDirs: ["extra dir"] };\n',
      );
      const stdout = createCaptureSink();
      await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

      const report = bySeverity(stdout.text());
      expect(
        report.errors
          .filter((issue: { code: string }) => issue.code.endsWith("-missing"))
          .map((issue: { code: string; fix: string; do?: string }) => [issue.code, issue.fix, issue.do]),
      ).toEqual([
        ["features-dir-missing", "Create my features/steps for the step files, or correct featuresDir in nukadoko.config.ts.", undefined],
        ["additional-feature-dir-missing", 'Create extra dir, or remove "extra dir" from additionalFeatureDirs in nukadoko.config.ts.', undefined],
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("exits 1 and reports every error category at least once", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-errors-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = bySeverity(stdout.text());
    const codes = report.errors.map((issue: { code: string }) => issue.code).sort();

    for (const expectedCode of [
      "unnamed-capture",
      "invalid-capture-key",
      "unknown-parameter-type",
      "args-not-object",
      "unknown-capture-key",
      "capture-type-mismatch",
      "alias-key-mismatch",
      "duplicate-pattern",
      "ambiguous-step",
      "table-docstring-key-mismatch",
      "undefined-step",
      "feature-parse-error",
    ]) {
      expect(codes).toContain(expectedCode);
    }
    expect(exitCode).toBe(1);
  });

  it("every issue has a stable kebab-case code and a message", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], {
      rootDir: fixture("check-errors-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    for (const issue of [...report.errors, ...report.warnings]) {
      expect(issue.code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it("prints one finding line per issue, each followed by its fix or do line, when --json is omitted", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check"], {
      rootDir: fixture("check-errors-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const lines = stdout.text().trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const [index, line] of lines.entries()) {
      expect(line).toMatch(index % 2 === 0 ? /^error\t/ : /^  (fix|do): \S/);
    }
  });

  it("undefined-step hints at an escapable near-miss pattern (fineract-style bare parens)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-escape-hint-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const undefinedIssues = report.errors.filter(
      (issue: { code: string }) => issue.code === "undefined-step",
    );
    expect(undefinedIssues).toHaveLength(7);
    expect(
      undefinedIssues.map((issue: { line: number; message: string; fix?: string; do?: string }) => [
        issue.line,
        issue.message.slice(0, issue.message.indexOf("; patterned steps")),
        issue.fix,
        issue.do,
      ]),
    ).toEqual([
      [
        4,
        'No step definition matches "the amount (USD) is "100""; it would match step "amount-step" pattern "the amount (USD) is {amount:string}" if its bare ( ) / were escaped (cucumber-expressions reads bare ( ) as optional text and / as alternation)',
        'Escape the bare ( ) and / in the pattern of step "amount-step" as \\( \\) and \\/.',
        undefined,
      ],
      [7, 'No step definition matches "this text matches nothing at all and has no relation to any pattern"', undefined, "nuka scaffold --feature features/escape.feature"],
      [
        10,
        'No step definition matches "the probe is green"; step "amount-step" with pattern "the probe is {amount:string}" takes a quoted value at this position, as a {...:string} parameter',
        'Rewrite line 10 of features/escape.feature as: Given the probe is "green"',
        undefined,
      ],
      [
        13,
        'No step definition matches "the probe state is not"; step "amount-step" with pattern "the probe state {amount:string}" takes a quoted value at this position, as a {...:string} parameter',
        'Rewrite line 13 of features/escape.feature as: Given the probe state "is not"',
        undefined,
      ],
      [16, 'No step definition matches "the ambiguous probe is green"', undefined, "nuka scaffold --feature features/escape.feature"],
      [19, 'No step definition matches "unrelated the probe is green"', undefined, "nuka scaffold --feature features/escape.feature"],
      [
        22,
        'No step definition matches "literal {string} green"; step "amount-step" with pattern "literal \\{string\\} {amount:string}" takes a quoted value at this position, as a {...:string} parameter',
        'Rewrite line 22 of features/escape.feature as: Given literal {string} "green"',
        undefined,
      ],
    ]);

    expect(exitCode).toBe(1);
  });

  it("refuses a ConfigError under --json as one refused finding on stdout, exit 2", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as { verdict: string; findings: { severity: string; code: string; message: string; fix: string }[] };
    expect(report.verdict).toBe("refused");
    expect(report.findings).toHaveLength(1);
    expect([report.findings[0]!.severity, report.findings[0]!.code]).toEqual(["refused", "config-invalid"]);
    expect(report.findings[0]!.message).toContain("typo");
    expect(report.findings[0]!.fix).toBe("Correct the fields the message names in nukadoko.config.ts.");
  });
});

describe("nuka check [feature..]", () => {
  it("detects an undefined step in a feature outside featuresDir when given as an argument", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "acceptance/outside.feature", "--json"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const undefinedIssues = report.errors.filter((issue: { code: string }) => issue.code === "undefined-step");
    expect(undefinedIssues).toHaveLength(1);
    expect(undefinedIssues[0].message).toContain("this step is undefined outside featuresDir");
    expect(exitCode).toBe(1);
  });

  it("accepts an absolute path the same way", async () => {
    const stdout = createCaptureSink();
    const rootDir = fixture("check-feature-arg-project");
    const exitCode = await runCli(["check", path.join(rootDir, "acceptance/outside.feature"), "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const undefinedIssues = report.errors.filter((issue: { code: string }) => issue.code === "undefined-step");
    expect(undefinedIssues).toHaveLength(1);
    expect(undefinedIssues[0].message).toContain("this step is undefined outside featuresDir");
    expect(exitCode).toBe(1);
  });

  it("does not mix in featuresDir's own feature errors when a feature argument is given", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "acceptance/outside.feature", "--json"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const messages = [...report.errors, ...report.warnings].map((issue: { message: string }) => issue.message);
    expect(messages.join("\n")).not.toContain("this step is undefined inside featuresDir");
    expect(report.errors.every((issue: { file?: string }) => issue.file !== "features/inside.feature")).toBe(true);
  });

  it("still runs config and binding checks when a feature argument is given", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "acceptance/outside.feature", "--json"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const codes = report.errors.map((issue: { code: string }) => issue.code);
    expect(codes).toContain("unknown-parameter-type");
  });

  it("no argument still checks every feature under featuresDir, unchanged", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const messages = [...report.errors].map((issue: { message: string }) => issue.message);
    expect(messages.join("\n")).toContain("this step is undefined inside featuresDir");
    expect(messages.join("\n")).not.toContain("this step is undefined outside featuresDir");
    expect(exitCode).toBe(1);
  });

  it("a nonexistent feature path prints to stderr and exits 2, with no report", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "acceptance/does-not-exist.feature"], {
      rootDir: fixture("check-feature-arg-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("nuka check");
    expect(stderr.text()).toContain("acceptance/does-not-exist.feature");
  });
});
