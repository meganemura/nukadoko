import { describe, expect, it } from "vitest";
import { discoverMarkdownFiles, parseAcceptanceRecord } from "../src/tend/record-parse.js";

// Responsibility: unit tests for src/tend/record-parse.ts's own read-side
// branches that a real accepted project (tend.test.ts, tend-moved-
// findings.test.ts) never exercises: a directory that cannot be listed at
// all, and the several ways a `.md` file can claim record-ness in its
// frontmatter and still fail to decode. `parseAcceptanceRecord` takes
// already-read text, so every "malformed" case here is a literal string
// this file hand-assembles, exactly the shape a corrupted or hand-edited
// record file would have on disk, never a shape this module's own writer
// (src/accept/render-record.ts) would ever produce.

describe("discoverMarkdownFiles", () => {
  it("returns no files, rather than throwing, when the root directory itself cannot be listed", () => {
    const files = discoverMarkdownFiles("/this/path/does/not/exist/at/all/nukadoko-test");
    expect(files).toEqual([]);
  });
});

const MINIMAL_FEATURE_SOURCE = "Feature: Checkout\n  Scenario: a customer checks out\n";

function minimalStepBlock(): string {
  return ["```json", JSON.stringify({ step: "a step", status: "ok", step_record_id: "step-1" }, null, 2), "```"].join(
    "\n",
  );
}

/** A record whose frontmatter has all four required keys but `feature:`
 * itself carries no value at all (no space, nothing after the colon) — the
 * one shape that passes `looksLikeRecordFrontmatter`'s own prefix-only check
 * yet still fails the stricter `/^feature: (.*)$/m` read. */
function frontmatterWithBlankFeature(): string {
  return ["---", "run_id: r1", "commit: abc", "feature:", "scenarios:", "---", ""].join("\n");
}

describe("parseAcceptanceRecord: frontmatter shape", () => {
  it("reads ordinary markdown with no frontmatter at all as not-a-record", () => {
    const result = parseAcceptanceRecord("# Just a heading\n\nSome prose.\n", "README.md");
    expect(result).toEqual({ kind: "not-a-record" });
  });

  it("reads a frontmatter block missing one of the four required keys as not-a-record", () => {
    const content = ["---", "title: something else entirely", "---", "", "body"].join("\n");
    const result = parseAcceptanceRecord(content, "notes.md");
    expect(result).toEqual({ kind: "not-a-record" });
  });

  it("reports malformed when feature: is present as a key but carries no value", () => {
    const result = parseAcceptanceRecord(frontmatterWithBlankFeature(), "broken.md");
    expect(result).toEqual({ kind: "malformed", reason: "frontmatter has no feature: value" });
  });

  it("reports malformed when the feature: value is quoted but the quoting itself is broken", () => {
    const content = [
      "---",
      "run_id: r1",
      "commit: abc",
      'feature: "unterminated',
      "scenarios:",
      "---",
      "",
    ].join("\n");
    const result = parseAcceptanceRecord(content, "broken.md");
    expect(result).toEqual({
      kind: "malformed",
      reason: "frontmatter's feature: value could not be decoded",
    });
  });

  it("decodes a quoted feature: value the same way JSON.parse would", () => {
    const content = [
      "---",
      "run_id: r1",
      "commit: abc",
      'feature: "features/checkout.feature"',
      "scenarios:",
      "---",
      "",
      "## The scenario as it ran",
      "",
      "```gherkin",
      MINIMAL_FEATURE_SOURCE.replace(/\n$/, ""),
      "```",
      "",
      minimalStepBlock(),
    ].join("\n");

    const result = parseAcceptanceRecord(content, "record.md");

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.record.featurePath).toBe("features/checkout.feature");
    }
  });
});

describe("parseAcceptanceRecord: body shape", () => {
  const validFrontmatter = ["---", "run_id: r1", "commit: abc", "feature: features/checkout.feature", "scenarios:", "---"];

  it("reports malformed when the gherkin fence is missing entirely", () => {
    const content = [...validFrontmatter, "", "no scenario section here at all"].join("\n");
    const result = parseAcceptanceRecord(content, "broken.md");
    expect(result).toEqual({
      kind: "malformed",
      reason: 'missing the "## The scenario as it ran" fenced feature source',
    });
  });

  it("reports malformed when a fenced json block is not valid JSON", () => {
    const content = [
      ...validFrontmatter,
      "",
      "## The scenario as it ran",
      "",
      "```gherkin",
      MINIMAL_FEATURE_SOURCE.replace(/\n$/, ""),
      "```",
      "",
      "```json",
      "{ not valid json",
      "```",
    ].join("\n");

    const result = parseAcceptanceRecord(content, "broken.md");

    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.reason).toContain("a fenced JSON block is not valid JSON");
    }
  });
});
