import { describe, expect, it } from "vitest";
import { buildDiagnosticsFromCheckReport } from "../../src/diagnostics/build-diagnostics.js";

describe("buildDiagnosticsFromCheckReport", () => {
  it("flattens errors and warnings, tagging each with its own severity", () => {
    const report = {
      errors: [{ code: "undefined-step", message: "no step matches", file: "features/todo.feature", line: 3 }],
      warnings: [{ code: "then-mutates", message: "bound in Then position", file: "features/steps/x.ts", line: 7 }],
    };

    const entries = buildDiagnosticsFromCheckReport(JSON.stringify(report));

    expect(entries).toEqual([
      {
        file: "features/todo.feature",
        line: 3,
        message: "no step matches",
        severity: "error",
        code: "undefined-step",
      },
      {
        file: "features/steps/x.ts",
        line: 7,
        message: "bound in Then position",
        severity: "warning",
        code: "then-mutates",
      },
    ]);
  });

  it("keeps an issue that has no file, using an empty string rather than dropping it", () => {
    const report = {
      errors: [{ code: "features-dir-missing", message: "featuresDir does not exist" }],
      warnings: [],
    };

    const entries = buildDiagnosticsFromCheckReport(JSON.stringify(report));

    expect(entries).toEqual([
      { file: "", line: undefined, message: "featuresDir does not exist", severity: "error", code: "features-dir-missing" },
    ]);
  });

  it("keeps an issue that has a file but no line", () => {
    const report = {
      errors: [{ code: "feature-parse-error", message: "Parser errors", file: "features/broken.feature" }],
      warnings: [],
    };

    const entries = buildDiagnosticsFromCheckReport(JSON.stringify(report));

    expect(entries).toEqual([
      {
        file: "features/broken.feature",
        line: undefined,
        message: "Parser errors",
        severity: "error",
        code: "feature-parse-error",
      },
    ]);
  });

  it("returns an empty array for a clean report", () => {
    const entries = buildDiagnosticsFromCheckReport(JSON.stringify({ errors: [], warnings: [] }));
    expect(entries).toEqual([]);
  });
});
