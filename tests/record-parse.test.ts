import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { discoverMarkdownFiles, parseAcceptanceRecord } from "../src/tend/record-parse.js";
import { findSignoffRot } from "../src/tend/signoff-rot.js";

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

// A checkout with `core.autocrlf` and an editor that writes a UTF-8 BOM
// rewrite bytes around a record without rewriting the record. The patterns
// in this module require a leading `---` and LF, so either rewrite misses,
// and a miss is ordinary Markdown, which every caller skips. The record is
// then counted as healthy. These cases are the transport, not a second
// document shape.
const UTF8_BOM = "\uFEFF";
const featureLine = gs.text({ alphabet: "abc ", minSize: 1, maxSize: 40 });

function withCrlf(lf: string): string {
  return lf.replace(/\n/g, "\r\n");
}

function transportVariants(lf: string): string[] {
  const crlf = withCrlf(lf);
  return [crlf, `${UTF8_BOM}${lf}`, `${UTF8_BOM}${crlf}`];
}

function validRecord(featureSource: string): string {
  return [
    "---",
    "run_id: r1",
    "commit: abc",
    "feature: elsewhere/checkout.feature",
    "scenarios:",
    "---",
    "",
    "## The scenario as it ran",
    "",
    "```gherkin",
    featureSource.replace(/\n$/, ""),
    "```",
    "",
    minimalStepBlock(),
    "",
  ].join("\n");
}

describe("parseAcceptanceRecord: line endings and a BOM", () => {
  it("reads ordinary markdown with CRLF or a leading BOM as not-a-record", () => {
    const heading = "# Just a heading\n\nSome prose.\n";
    const otherFrontmatter = ["---", "title: notes", "---", "", "body"].join("\n");
    for (const lf of [heading, otherFrontmatter]) {
      for (const content of transportVariants(lf)) {
        expect(parseAcceptanceRecord(content, "README.md")).toEqual({ kind: "not-a-record" });
      }
    }
  });

  it("reads a sign-off the same way when the file uses CRLF or starts with a UTF-8 BOM", () => {
    const lf = validRecord(MINIMAL_FEATURE_SOURCE);
    const expected = parseAcceptanceRecord(lf, "record.md");
    expect(expected.kind).toBe("ok");
    for (const content of transportVariants(lf)) {
      expect(parseAcceptanceRecord(content, "record.md")).toEqual(expected);
    }
  });

  it("parses a sign-off the same way for any feature line, after CRLF conversion or a leading BOM", () =>
    hegel.test((tc) => {
      const line = tc.draw(featureLine);
      const lf = validRecord(`Feature: Checkout\n  Scenario: ${line}\n`);
      const expected = parseAcceptanceRecord(lf, "record.md");
      expect(expected.kind).toBe("ok");
      for (const content of transportVariants(lf)) {
        expect(parseAcceptanceRecord(content, "record.md")).toEqual(expected);
      }
    }));

  it("reports a broken record as malformed when CRLF or a BOM would otherwise hide it", () => {
    const lf = [
      "---",
      "run_id: r1",
      "commit: abc",
      "feature: elsewhere/checkout.feature",
      "scenarios:",
      "---",
      "",
      "no scenario section here at all",
    ].join("\n");
    for (const content of transportVariants(lf)) {
      expect(parseAcceptanceRecord(content, "broken.md")).toEqual({
        kind: "malformed",
        reason: 'missing the "## The scenario as it ran" fenced feature source',
      });
    }
  });
});

describe("findSignoffRot: line endings and a BOM", () => {
  // The frozen feature and the file on disk can both be rewritten by the
  // same checkout. Recognition alone is not enough: once the record parses,
  // a comparison that still sees the carriage returns reports a feature
  // change that nobody made.
  it("reports a real feature edit, and ignores a checkout that only rewrote line endings", async () => {
    const feature = "Feature: Checkout\n  Scenario: a customer checks out\n";
    const lfRecord = validRecord(feature);
    expect(parseAcceptanceRecord(`${UTF8_BOM}${withCrlf(lfRecord)}`, "record.md").kind).toBe("ok");

    const root = await mkdtemp(path.join(os.tmpdir(), "nukadoko-signoff-"));
    try {
      const recordPath = path.join(root, "acceptance", "record.md");
      const featurePath = path.join(root, "elsewhere", "checkout.feature");
      await mkdir(path.dirname(recordPath), { recursive: true });
      await mkdir(path.dirname(featurePath), { recursive: true });

      await writeFile(recordPath, withCrlf(lfRecord));
      await writeFile(featurePath, feature.replace("checks out", "checks out twice"));
      const changed = findSignoffRot(root, new Map(), "features", []).filter((issue) => issue.code === "signoff-feature-changed");
      expect(changed).toHaveLength(1);
      expect(changed[0]!.file).toBe(path.relative(root, recordPath));

      await writeFile(recordPath, `${UTF8_BOM}${withCrlf(lfRecord)}`);
      await writeFile(featurePath, `${UTF8_BOM}${withCrlf(feature)}`);
      const lineEndingsOnly = findSignoffRot(root, new Map(), "features", []).filter(
        (issue) => issue.code === "signoff-feature-changed",
      );
      expect(lineEndingsOnly).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
