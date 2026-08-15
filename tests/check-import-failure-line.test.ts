import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `step-file-import-
// failed` findings get `CheckIssue.line` filled in when (and only when) the
// underlying message itself already names a position, extracted rather than
// re-derived some other way (message stays verbatim either way).
//
// tests/fixtures/check-import-failure-location-project has one step file
// (broken.ts) whose own fixture-bag name (`page`) is redeclared directly
// under the function it's destructured into — an early ECMAScript error
// esbuild's own transform catches before this step's `run()` body ever
// executes (measured directly: "Transform failed with 1 error:\n<path>:
// <line>:<col>: ERROR: The symbol \"page\" has already been declared").
// `// @ts-nocheck` at that file's own top is what keeps the very same
// redeclaration from *also* being a `tsc` error under `npm run typecheck`
// (tsconfig.json's own include is "tests/**/*.ts", which reaches fixtures
// too) — esbuild's own transform runs regardless of that pragma (measured
// directly), so the import failure this fixture exists to produce survives
// untouched.
//
// tests/fixtures/check-import-failure-location-shared-project has the same
// broken.ts plus a second file (via-import.ts) that only side-effect
// imports it: Node's ESM loader caches broken.ts's failure and rethrows the
// identical error to via-import.ts too, so the two entries share one
// message byte-for-byte, but that message's own location names broken.ts's
// path, never via-import.ts's.
//
// tests/fixtures/check-import-failure-project (require()-in-ESM, an
// existing fixture) is reused for the location-less case: Node's own
// ESM-loader error carries no location at all.

describe("nuka check: step-file-import-failed carries a line when the message has one", () => {
  it("fills line from an esbuild transform error's own <path>:<line>:<col> location", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-location-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; file?: string; line?: number; message: string }>;
    };
    const brokenIssue = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(brokenIssue).toBeDefined();
    expect(brokenIssue?.file).toBe("features/steps/broken.ts");
    expect(brokenIssue?.message).toContain('The symbol "page" has already been declared');
    // Measured directly against this exact fixture file: line 22 is
    // `const page = 1;`, the redeclaration esbuild's transform reports.
    expect(brokenIssue?.line).toBe(22);
    expect(exitCode).toBe(1);
  });

  it("human-readable output prints file:line for this ungrouped single-file case", async () => {
    const stdout = createCaptureSink();
    await runCli(["check"], {
      rootDir: fixture("check-import-failure-location-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const text = stdout.text();
    expect(text).toContain("features/steps/broken.ts:22\t");
  });

  it("does not fill line, and the message is unchanged, for a location-less Node ESM error", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; file?: string; line?: number; message: string }>;
    };
    const importIssue = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(importIssue).toBeDefined();
    expect(importIssue?.message).toContain("require is not defined");
    expect(importIssue?.line).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  it("does not fill line when the message's location names a different file (rethrown import)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-location-shared-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; file?: string; line?: number; message: string }>;
    };
    const importFailures = report.errors.filter((issue) => issue.code === "step-file-import-failed");
    expect(importFailures).toHaveLength(2);

    const brokenIssue = importFailures.find((issue) => issue.file === "features/steps/broken.ts");
    const viaImportIssue = importFailures.find((issue) => issue.file === "features/steps/via-import.ts");
    expect(brokenIssue).toBeDefined();
    expect(viaImportIssue).toBeDefined();

    // Both share the identical message (Node's ESM loader rethrows the
    // cached failure verbatim) — the location it names is broken.ts's own,
    // so only broken.ts's own entry gets `line`.
    expect(brokenIssue?.message).toBe(viaImportIssue?.message);
    // This project's own broken.ts has one extra comment line naming
    // via-import.ts, so the redeclaration sits on line 23 here (measured
    // directly), not the 22 the standalone location-project's copy has.
    expect(brokenIssue?.line).toBe(23);
    expect(viaImportIssue?.line).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  it("grouped human-readable display never prints a line, even though one member's own entry has one", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check"], {
      rootDir: fixture("check-import-failure-location-shared-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const text = stdout.text();
    const importFailedLines = text.split("\n").filter((line) => line.startsWith("error\tstep-file-import-failed"));
    // One grouped line for both files sharing the message, never two
    // separate lines (the same fold tests/check-import-failure-grouping
    // .test.ts already exercises for a location-less shared message).
    expect(importFailedLines).toHaveLength(1);

    const grouped = importFailedLines[0];
    expect(grouped).toContain("(2 files)");
    // Never a stray ":<number>" tacked onto the "(2 files)" column: a
    // message shared across files can't say which one file a location
    // inside it belongs to, even when (as here) one of the two members'
    // own CheckIssue *does* carry a `line` (the JSON-level test above
    // proves that) — src/cli/check.ts's own `formatImportFailureGroup`
    // never reads `line` once there is more than one file in the group.
    expect(grouped).not.toMatch(/\(2 files\):\d/);
    expect(exitCode).toBe(1);
  });
});
