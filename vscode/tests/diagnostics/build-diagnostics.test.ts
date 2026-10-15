import { describe, expect, it } from "vitest";
import { readCheckReport } from "../../src/diagnostics/build-diagnostics.js";

describe("readCheckReport", () => {
  it("flattens errors and warnings, tagging each with its own severity", () => {
    const report = {
      errors: [{ code: "undefined-step", message: "no step matches", file: "features/todo.feature", line: 3 }],
      warnings: [{ code: "then-mutates", message: "bound in Then position", file: "features/steps/x.ts", line: 7 }],
    };

    const reading = readCheckReport(JSON.stringify(report));

    expect(reading.kind === "report" && reading.entries).toEqual([
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

    const reading = readCheckReport(JSON.stringify(report));

    expect(reading.kind === "report" && reading.entries).toEqual([
      { file: "", line: undefined, message: "featuresDir does not exist", severity: "error", code: "features-dir-missing" },
    ]);
  });

  it("keeps an issue that has a file but no line", () => {
    const report = {
      errors: [{ code: "feature-parse-error", message: "Parser errors", file: "features/broken.feature" }],
      warnings: [],
    };

    const reading = readCheckReport(JSON.stringify(report));

    expect(reading.kind === "report" && reading.entries).toEqual([
      {
        file: "features/broken.feature",
        line: undefined,
        message: "Parser errors",
        severity: "error",
        code: "feature-parse-error",
      },
    ]);
  });

  it("reads a clean report as no entries", () => {
    const reading = readCheckReport(JSON.stringify({ errors: [], warnings: [] }));
    expect(reading).toEqual({ kind: "report", entries: [] });
  });

  it("names the first line of output that is not a report", () => {
    const reading = readCheckReport('noisy-step loaded\n{\n  "errors": [],\n  "warnings": []\n}\n');
    expect(reading).toEqual({ kind: "unreadable", firstLine: "noisy-step loaded" });
  });

  it("reads JSON without errors and warnings arrays as unreadable", () => {
    expect(readCheckReport('{"error":"no config"}')).toEqual({ kind: "unreadable", firstLine: '{"error":"no config"}' });
  });
});
