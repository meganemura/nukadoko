import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { assertionDetailLines, formatStepFailure } from "../src/run/progress-log.js";

// Responsibility: a failed step's stderr lines carry what a Playwright
// `expect` compared, not only the matcher's name. The messages below are
// the shapes Playwright 1.61.1 throws (measured): a value matcher and two
// locator matchers.

const valueMessage = "expect(received).toBe(expected) // Object.is equality\n\nExpected: 3\nReceived: 2";
const locatorMessage =
  "expect(locator).toHaveText(expected) failed\n\nLocator:  locator('#who')\nExpected: \"aki\"\n" +
  "Received: \"ben\"\nTimeout:  300ms\n\nCall log:\n  - Expect \"to.have.text\" with timeout 300ms\n" +
  "  - waiting for locator('#who')\n    Expected: not this line\n";
const notFoundMessage =
  "expect(locator).toBeVisible() failed\n\nLocator: locator('#nope')\nExpected: visible\nTimeout: 300ms\n" +
  "Error: element(s) not found\n\nCall log:\n  - Expect \"to.be.visible\" with timeout 300ms\n";

describe("assertionDetailLines", () => {
  it("names both values of a value matcher", () => {
    expect(formatStepFailure({ errorMessage: valueMessage, recordPath: null })).toEqual([
      "expect(received).toBe(expected) // Object.is equality",
      "Expected: 3",
      "Received: 2",
    ]);
  });

  it("names the locator and both values, and stops at the call log", () => {
    expect(assertionDetailLines(locatorMessage)).toEqual([
      "Locator:  locator('#who')",
      'Expected: "aki"',
      'Received: "ben"',
    ]);
    expect(assertionDetailLines(notFoundMessage)).toEqual([
      "Locator: locator('#nope')",
      "Expected: visible",
      "Error: element(s) not found",
    ]);
  });

  it("adds nothing to a message that is not an expect call", () =>
    hegel.test((tc) => {
      const message = tc.draw(gs.text({ maxSize: 200 })).replace(/expect\(/g, "");
      expect(assertionDetailLines(message)).toEqual([]);
    }));

  it("keeps at most four lines of at most 200 characters, each one from the message", () =>
    hegel.test((tc) => {
      const values = tc.draw(gs.arrays(gs.text({ minSize: 0, maxSize: 400 }), { minSize: 0, maxSize: 8 }));
      const lines = values.map((value, index) => `${index % 2 === 0 ? "Expected" : "Received"}: ${value.replace(/[\r\n\u2028\u2029\u001b]/g, " ")}`);
      const message = ["expect(received).toEqual(expected)", "", ...lines].join("\n");
      const details = assertionDetailLines(message);
      expect(details.length).toBeLessThanOrEqual(4);
      for (const detail of details) {
        expect(detail.length).toBeLessThanOrEqual(203);
        const kept = detail.endsWith("...") && detail.length === 203 ? detail.slice(0, 200) : detail;
        expect(lines.some((line) => line.trim().startsWith(kept))).toBe(true);
      }
    }));
});
