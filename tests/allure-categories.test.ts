import { Status } from "allure-js-commons";
import { describe, expect, it } from "vitest";
import { buildCategories } from "../src/report/allure/categories.js";
import { buildFailureMarker, statusForKind } from "../src/report/allure/map-scenario.js";
import type { ErrorKind } from "../src/receipt/types.js";

const ALL_KINDS: readonly ErrorKind[] = [
  "args_invalid",
  "result_invalid",
  "binding_invalid",
  "world_invalid",
  "then_mutated",
  "read_only_violation",
  "timeout",
  "unsupported",
  "step_error",
];

describe("buildCategories", () => {
  it("writes exactly nine rules, one per ErrorKind", () => {
    const categories = buildCategories();
    expect(categories).toHaveLength(9);
  });

  it.each(ALL_KINDS)("rule for %s matches the status statusForKind assigns it", (kind) => {
    const category = buildCategories().find((c) => c.messageRegex === `${escapeForTest(buildFailureMarker(kind))}[\\s\\S]*`);
    expect(category).toBeDefined();
    const expectedStatus = statusForKind(kind) === "failed" ? Status.FAILED : Status.BROKEN;
    expect(category?.matchedStatuses).toEqual([expectedStatus]);
  });

  it("escapes regex-significant characters in the marker", () => {
    // The marker itself (`[nukadoko.failure=<kind>]`) contains `[`, `]`,
    // and `.` — all regex-significant. Every rule's own regex must escape
    // them so it matches the literal marker text, not an unintended
    // character class/wildcard.
    const category = buildCategories().find((c) => c.name?.includes("args"));
    expect(category?.messageRegex).toBe("\\[nukadoko\\.failure=args_invalid\\][\\s\\S]*");
  });

  it("actually matches a marker-prefixed message end to end", () => {
    for (const kind of ALL_KINDS) {
      const category = buildCategories().find((c) => new RegExp(String(c.messageRegex)).test(`${buildFailureMarker(kind)} boom`));
      expect(category, `no category matched kind ${kind}`).toBeDefined();
    }
  });

  it("gives each rule a human-readable name", () => {
    for (const category of buildCategories()) {
      expect(typeof category.name).toBe("string");
      expect(category.name?.length).toBeGreaterThan(0);
    }
  });
});

function escapeForTest(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
