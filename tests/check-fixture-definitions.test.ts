import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `auto: true` is refused with its own dedicated
// message, and `nuka check`
// catches a fixture dependency cycle, a scope violation, and an unowned
// `page` override, all before anything runs. Read-only against
// tests/fixtures/broken-fixtures-project and tests/fixtures/
// fixture-auto-project (neither test ever executes a step, so no temp copy
// is needed — the same choice tests/check-fixture-structural.test.ts makes
// for the same reason).

describe("nuka check: fixture definition findings", () => {
  it("reports fixture-cycle, fixture-scope-violation, and page-override-unowned", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("broken-fixtures-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout.text()) as { errors: { code: string; message: string; file?: string }[] };
    const codes = report.errors.map((issue) => issue.code);

    expect(codes).toContain("fixture-cycle");
    expect(codes).toContain("fixture-scope-violation");
    expect(codes).toContain("page-override-unowned");

    const cycleIssue = report.errors.find((issue) => issue.code === "fixture-cycle");
    expect(cycleIssue?.message).toMatch(/a -> b -> a|b -> a -> b/);
    expect(cycleIssue?.file).toBe("nukadoko.config.ts");

    const scopeIssue = report.errors.find((issue) => issue.code === "fixture-scope-violation");
    expect(scopeIssue?.message).toContain("seededDb");
    expect(scopeIssue?.message).toContain("page");

    const overrideIssue = report.errors.find((issue) => issue.code === "page-override-unowned");
    expect(overrideIssue?.message).toContain("page");
  });

  it("refuses execution too, the same way an unknown fixture name already does (nuka run)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/noop.feature"], {
      rootDir: fixture("broken-fixtures-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toMatch(/fixture-cycle|cycle/i);
  });
});

describe("nuka check / nuka run: auto: true is refused with its own dedicated message", () => {
  it("nuka check fails to even produce a report: config load itself is refused", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check"], {
      rootDir: fixture("fixture-auto-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain('"auto"');
    // Names why: this is not a claim of deeper Playwright fixture
    // compatibility than the shape of a definition.
    expect(stderr.text()).toMatch(/names everything that ran|Playwright fixture/);
  });

  it("nuka run is refused the same way", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/noop.feature"], {
      rootDir: fixture("fixture-auto-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain('"auto"');
  });
});
