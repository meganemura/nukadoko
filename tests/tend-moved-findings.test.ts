import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

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
    const report = bySeverity(stdout.text());
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

    const report = bySeverity(stdout.text());
    const supportOrigin = report.notes.find(
      (issue: { code: string }) => issue.code === "parameter-type-support-origin",
    );
    expect(supportOrigin).toBeDefined();
    const expectedRelativePath = path.join("features", "steps", "compat-glue.ts");
    expect(supportOrigin.file).toBe(expectedRelativePath);
    expect(path.isAbsolute(supportOrigin.file)).toBe(false);
    expect(supportOrigin.message).toContain(expectedRelativePath);
  });

  it("parameter-type-support-origin: tells a registration that sets preferForRegexpMatch to stay in support code, and still offers the move to one that does not", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("compat-prefer-regexp-match-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
    const file = path.join("features", "steps", "code-glue.ts");
    const supportOrigin = report.notes.filter(
      (issue: { code: string }) => issue.code === "parameter-type-support-origin",
    );
    expect(supportOrigin).toEqual([
      {
        code: "parameter-type-support-origin",
        message: `Custom parameter type "codeA" is registered from compat ("support") code at ${file}, not from config.parameterTypes: config is the typed-era home for parameter type registrations; both share one registry today, so moving this one is a safe, meaning-preserving step whenever it's convenient`,
        file,
        fix: "Move the defineParameterType call into config.parameterTypes, unless a RegExp step needs its preferForRegexpMatch.",
      },
      {
        code: "parameter-type-support-origin",
        message: `Custom parameter type "codeB" is registered from compat ("support") code at ${file} with preferForRegexpMatch: keep it in support code while a RegExp step relies on that preference; config.parameterTypes rejects the key, and without it a RegExp group that another type also matches fails again`,
        file,
        fix: "Move the defineParameterType call into config.parameterTypes, unless a RegExp step needs its preferForRegexpMatch.",
      },
    ]);
    expect(exitCode).toBe(0);
  });

  it("secrets-public-key-unknown: names the key, appears as a note, and does not fail the run", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("check-warnings-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text());
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

    const report = bySeverity(stdout.text());
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
