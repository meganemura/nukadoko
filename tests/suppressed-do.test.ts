import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { playwrightImportMissing } from "../src/check/playwright-check.js";
import { importSuppressionDo } from "../src/check/suppressed-do.js";
import type { CheckIssue } from "../src/check/types.js";
import { PLAYWRIGHT_VERSION } from "../src/context/load-playwright.js";

const PACKAGES = ["playwright", "playwright-core", "@playwright/test"] as const;

function playwrightFinding(missingPackage: string): CheckIssue {
  return playwrightImportMissing({ filePath: "features/steps/a.ts", missingPackage: { name: missingPackage } })!;
}

const importFailed: CheckIssue = {
  code: "step-file-import-failed",
  message: "SyntaxError: Unexpected token",
  file: "features/steps/b.ts",
};

describe("importSuppressionDo", () => {
  it("gives the install line when every unreadable file lacks Playwright", () => {
    expect(importSuppressionDo([playwrightFinding("playwright"), playwrightFinding("playwright")])).toBe(
      `Run npm install -D -E playwright@${PLAYWRIGHT_VERSION} (see playwright-missing), then run nuka check again.`,
    );
  });

  it("names step-file-import-failed when that is the only cause", () => {
    expect(importSuppressionDo([importFailed])).toBe(
      "Correct the step-file-import-failed error, then run nuka check again.",
    );
    expect(importSuppressionDo([importFailed, importFailed])).toBe(
      "Correct the step-file-import-failed errors, then run nuka check again.",
    );
  });

  it("names both when both were reported", () => {
    expect(importSuppressionDo([importFailed, playwrightFinding("@playwright/test")])).toBe(
      `Run npm install -D -E @playwright/test@${PLAYWRIGHT_VERSION} (see playwright-missing) and correct the step-file-import-failed error, then run nuka check again.`,
    );
  });

  it("names exactly the codes and install lines among the findings", () =>
    hegel.test(
      (tc) => {
        const kinds = tc.draw(
          gs.arrays(gs.sampledFrom(["failed", ...PACKAGES] as const), { minSize: 1, maxSize: 6 }),
        );
        const findings = kinds.map((kind) => (kind === "failed" ? importFailed : playwrightFinding(kind)));
        const text = importSuppressionDo(findings);

        expect(text.endsWith(", then run nuka check again.")).toBe(true);
        expect(text.includes("step-file-import-failed")).toBe(kinds.includes("failed"));
        expect(text.includes("playwright-missing")).toBe(kinds.some((kind) => kind !== "failed"));
        for (const name of PACKAGES) {
          const install = `npm install -D -E ${name}@${PLAYWRIGHT_VERSION}`;
          expect(text.split(install).length - 1).toBe(kinds.includes(name) ? 1 : 0);
        }
      },
      { testCases: 200 },
    ));
});
