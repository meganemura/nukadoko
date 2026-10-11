import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check`'s report for a broken `config.fixtures`
// entry names that fixture, speaks about a fixture, and does not quote
// source after tsx has rewritten it. Neighbor to
// tests/check-fixture-definitions.test.ts (cycles, scope, page override)
// and tests/check-fixture-structural.test.ts (a step's own `run()`).

interface CheckIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly step?: string;
}

async function checkReport(rootDir: string) {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  return {
    exitCode,
    report: JSON.parse(stdout.text()) as { errors: CheckIssue[]; warnings: unknown[] },
  };
}

function findingsFor(errors: readonly CheckIssue[], fixtureName: string): CheckIssue[] {
  return errors.filter(
    (issue) => issue.code === "fixture-structural-violation" && issue.message.includes(`fixture "${fixtureName}"`),
  );
}

describe("nuka check: a broken config fixture is named in fixture wording", () => {
  it("names each broken fixture and does not quote transformed source", async () => {
    const { report, exitCode } = await checkReport(fixture("config-fixture-structural-project"));
    expect(exitCode).toBe(1);

    const beta = findingsFor(report.errors, "beta");
    expect(beta).toHaveLength(1);
    expect(beta[0]!.file).toBe("nukadoko.config.ts");
    expect(beta[0]!.step).toBeUndefined();
    expect(beta[0]!.message).not.toMatch(/run\(\)/);
    expect(beta[0]!.message).not.toMatch(/\bstep\b/);
    expect(beta[0]!.message).not.toContain("void 0");
    expect(beta[0]!.message).not.toContain("page=void 0");

    const alpha = findingsFor(report.errors, "alpha");
    expect(alpha).toHaveLength(1);
    expect(alpha[0]!.message).not.toMatch(/run\(\)/);
    expect(alpha[0]!.message).not.toMatch(/\bstep\b/);

    const tenant = findingsFor(report.errors, "tenant");
    expect(tenant).toHaveLength(1);
    expect(tenant[0]!.message).toContain('unknown fixture "nope"');
    expect(tenant[0]!.message).not.toMatch(/run\(\)/);
    expect(tenant[0]!.message).not.toMatch(/\bstep\b/);

    const gamma = findingsFor(report.errors, "gamma");
    expect(gamma).toHaveLength(1);
    expect(gamma[0]!.message).toContain("rest property");
    expect(gamma[0]!.message).not.toMatch(/run\(\)/);
    expect(gamma[0]!.message).not.toMatch(/\bstep\b/);

    expect(findingsFor(report.errors, "ok")).toHaveLength(0);
  });

  it("passes a project whose only config fixture is well formed", async () => {
    const { report, exitCode } = await checkReport(fixture("valid-config-fixture-project"));
    const structural = report.errors.filter((issue) => issue.code === "fixture-structural-violation");
    expect(structural).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});
