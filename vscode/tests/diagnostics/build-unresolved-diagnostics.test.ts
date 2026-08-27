import { describe, expect, it } from "vitest";
import { buildUnresolvedDiagnostics } from "../../src/diagnostics/build-unresolved-diagnostics.js";

describe("buildUnresolvedDiagnostics", () => {
  it("returns an empty array for an empty input", () => {
    expect(buildUnresolvedDiagnostics([])).toEqual([]);
  });

  it("converts a single unresolved declaration, 1-indexing row into line and dropping column", () => {
    const entries = buildUnresolvedDiagnostics([
      {
        declarationFile: "/repo/features/steps/dynamic.ts",
        declarationPosition: { row: 0, column: 17 },
        reason: "pattern is a computed value, which cannot be resolved statically",
      },
    ]);

    expect(entries).toEqual([
      {
        file: "/repo/features/steps/dynamic.ts",
        line: 1,
        message:
          "This step declaration is statically unresolvable: pattern is a computed value, which cannot be resolved statically",
        severity: "warning",
        code: "nukadoko-static-unresolved",
      },
    ]);
  });

  it("converts multiple unresolved declarations, each keeping its own file, line, and reason", () => {
    const entries = buildUnresolvedDiagnostics([
      {
        declarationFile: "/repo/features/steps/a.ts",
        declarationPosition: { row: 4, column: 2 },
        reason: "reason a",
      },
      {
        declarationFile: "/repo/features/steps/b.ts",
        declarationPosition: { row: 41, column: 0 },
        reason: "reason b",
      },
    ]);

    expect(entries).toEqual([
      {
        file: "/repo/features/steps/a.ts",
        line: 5,
        message: "This step declaration is statically unresolvable: reason a",
        severity: "warning",
        code: "nukadoko-static-unresolved",
      },
      {
        file: "/repo/features/steps/b.ts",
        line: 42,
        message: "This step declaration is statically unresolvable: reason b",
        severity: "warning",
        code: "nukadoko-static-unresolved",
      },
    ]);
  });

  it("ignores column entirely -- two declarations differing only in column produce the same line", () => {
    const entries = buildUnresolvedDiagnostics([
      { declarationFile: "/repo/f.ts", declarationPosition: { row: 9, column: 0 }, reason: "r" },
      { declarationFile: "/repo/f.ts", declarationPosition: { row: 9, column: 99 }, reason: "r" },
    ]);

    expect(entries[0]?.line).toBe(10);
    expect(entries[1]?.line).toBe(10);
    expect(entries[0]).toEqual(entries[1]);
  });
});
