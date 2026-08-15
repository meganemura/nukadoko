import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: three findings that used to
// be `nuka check` warnings (`parameter-type-support-origin`,
// `secrets-public-key-unknown`, `secrets-redact-key-unknown`) now surface as
// `nuka tend` notes instead, same code, same detection, only the command
// that reports them changed. Every fixture here is the exact one
// tests/check-compat.test.ts / tests/check.test.ts / tests/check-secrets.test.ts
// already use to prove the finding no longer appears on `check` — reused
// rather than duplicated, so both sides of the move are checked against the
// same data.

describe("nuka tend: findings moved from nuka check", () => {
  it("parameter-type-support-origin: names the support-origin type and the config home it could move to, as a note, and does not fail the run", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("check-compat-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text());
    const supportOrigin = report.notes.find(
      (issue: { code: string }) => issue.code === "parameter-type-support-origin",
    );
    expect(supportOrigin).toBeDefined();
    expect(supportOrigin.message).toContain("shout-compat");
    expect(supportOrigin.message).toContain("config.parameterTypes");

    // Note only — never in `errors`, and never enough on its own to fail
    // the run (docs/spec.md "Tending": "the rest do not, because a project
    // is allowed to carry them").
    expect(report.errors.some((issue: { code: string }) => issue.code === "parameter-type-support-origin")).toBe(
      false,
    );
    expect(exitCode).toBe(0);
  });

  it("parameter-type-support-origin's file, and the path embedded in its message, are rootDir-relative like every other issue's file", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("check-compat-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const supportOrigin = report.notes.find(
      (issue: { code: string }) => issue.code === "parameter-type-support-origin",
    );
    expect(supportOrigin).toBeDefined();
    const expectedRelativePath = path.join("features", "steps", "compat-glue.ts");
    expect(supportOrigin.file).toBe(expectedRelativePath);
    expect(path.isAbsolute(supportOrigin.file)).toBe(false);
    expect(supportOrigin.message).toContain(expectedRelativePath);
  });

  it("secrets-public-key-unknown: names the key, appears as a note, and does not fail the run", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("check-warnings-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const unknownPublicKey = report.notes.find(
      (issue: { code: string }) => issue.code === "secrets-public-key-unknown",
    );
    expect(unknownPublicKey).toBeDefined();
    expect(unknownPublicKey.message).toContain("UNKNOWN_KEY");
    expect(report.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("secrets-redact-key-unknown: names the key, appears as a note, and does not fail the run — its secrets-redact-key-too-short neighbor stays check-only", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("check-secrets-redact-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text());
    const unknownRedactKey = report.notes.find(
      (issue: { code: string }) => issue.code === "secrets-redact-key-unknown",
    );
    expect(unknownRedactKey).toBeDefined();
    expect(unknownRedactKey.message).toContain("UNKNOWN_REDACT_KEY");

    // secrets-redact-key-too-short means plaintext reaches a log the moment
    // the run starts — it stays on `check`, not `tend`.
    expect(
      report.notes.some((issue: { code: string }) => issue.code === "secrets-redact-key-too-short"),
    ).toBe(false);
    expect(report.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });
});
