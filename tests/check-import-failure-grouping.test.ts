import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: fb5-loader-visibility task spec, decision 3 — `nuka
// check`'s human-readable (non `--json`) rendering groups
// `step-file-import-failed` findings that carry the exact same message
// under one printed message, instead of repeating Node's own ESM-loader
// error once per file it was rethrown to. `--json` is untouched: this is a
// display-only fold over `CheckReport.errors`, never a change to the data
// itself (this task's spec: "データ構造は変えない").
//
// tests/fixtures/check-import-failure-shared-cause-project has two files
// (a-imports-shared.ts, b-imports-shared.ts) plus the shared module they
// both import (shared-broken.ts, itself walked and imported directly too)
// sharing one message, and a third file (c-different-broken.ts) failing for
// an unrelated reason — three files, two distinct messages.

describe("nuka check: human formatter groups step-file-import-failed by message", () => {
  it("--json keeps one entry per file, message verbatim, data structure untouched", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-shared-cause-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
    };
    const importFailures = report.errors.filter((issue) => issue.code === "step-file-import-failed");
    // Four files were walked and failed to import: a-imports-shared.ts and
    // b-imports-shared.ts (which each side-effect-import shared-broken.ts),
    // shared-broken.ts itself (also walked and imported directly, so it
    // fails the same way), and c-different-broken.ts (a distinct cause).
    expect(importFailures).toHaveLength(4);
    expect(importFailures.map((issue) => issue.file).sort()).toEqual([
      "features/steps/a-imports-shared.ts",
      "features/steps/b-imports-shared.ts",
      "features/steps/c-different-broken.ts",
      "features/steps/shared-broken.ts",
    ]);
    expect(exitCode).toBe(1);
  });

  it("text output prints the shared message once with all three files listed, and the distinct message as its own line", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check"], {
      rootDir: fixture("check-import-failure-shared-cause-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const text = stdout.text();
    const importFailedLines = text
      .split("\n")
      .filter((line) => line.startsWith("error\tstep-file-import-failed"));

    // One line for the group header (3 files, one message), one line for
    // the lone distinct-message file — never three separate lines for the
    // shared cause.
    expect(importFailedLines).toHaveLength(2);

    const grouped = importFailedLines.find((line) => line.includes("(3 files)"));
    expect(grouped).toBeDefined();
    expect(grouped).toContain("require is not defined");
    // The message appears exactly once for the group, not once per file.
    expect(text.match(/require is not defined/g)).toHaveLength(1);

    // The three affected files are listed, in dictionary order, right after
    // the group's own header line.
    const groupIndex = text.split("\n").indexOf(grouped!);
    const followingLines = text.split("\n").slice(groupIndex + 1, groupIndex + 4);
    expect(followingLines).toEqual([
      "  features/steps/a-imports-shared.ts",
      "  features/steps/b-imports-shared.ts",
      "  features/steps/shared-broken.ts",
    ]);

    const distinct = importFailedLines.find((line) => line.includes("c-different-broken.ts"));
    expect(distinct).toBeDefined();
    expect(distinct).toContain("boom: a different cause");
    expect(distinct).not.toContain("(3 files)");

    expect(exitCode).toBe(1);
  });
});
