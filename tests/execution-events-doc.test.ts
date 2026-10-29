import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMON_FIELDS, EVENT_KINDS, type FieldSpec } from "../src/execution-events/format.js";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: docs/execution-events.md and the parser read one table
// of kinds and fields. Every kind the parser knows has a section there, and
// every field a row whose type, whether it is required, and the values it
// may hold are the ones EVENT_KINDS holds; the Japanese pair lists the same
// fields of the same kinds. A kind or a field added on one side and not on
// the other fails here.

interface Row {
  readonly field: string;
  readonly type: string;
  readonly required: string;
  readonly meaning: string;
}

/** The rows of each field table, by the section heading's code span:
 * a kind's name, or "common" for the common fields. */
function tables(file: string): Map<string, Row[]> {
  const found = new Map<string, Row[]>();
  let section: string | undefined;
  for (const line of readFileSync(path.join(repoRoot, file), "utf8").split("\n")) {
    const heading = /^##+ (.*)$/.exec(line);
    if (heading !== null) {
      const kind = /^`([a-z_]+)`:/.exec(heading[1]!);
      section = kind !== null ? kind[1] : /^(Common fields|共通のフィールド)$/.test(heading[1]!) ? "common" : undefined;
      continue;
    }
    const cells = /^\| `([a-z_]+)` \| ([^|]+) \| ([^|]+) \| (.*) \|$/.exec(line);
    if (section === undefined || cells === null) continue;
    const [, field, type, required, meaning] = cells as unknown as [string, string, string, string, string];
    found.set(section, [...(found.get(section) ?? []), { field, type: type.trim(), required: required.trim(), meaning }]);
  }
  return found;
}

const TYPE_WORDS: Readonly<Record<FieldSpec["type"], string>> = {
  string: "string",
  integer: "integer",
  number: "number",
  boolean: "boolean",
  strings: "array of strings",
  ids: "array of strings or integers",
};

function typeText(spec: FieldSpec): string {
  return `${TYPE_WORDS[spec.type]}${spec.nullable === true ? " or `null`" : ""}`;
}

describe("docs/execution-events.md", () => {
  const english = tables("docs/execution-events.md");

  it("has a section for each kind the parser knows, and no other", () => {
    expect([...english.keys()].filter((key) => key !== "common").sort()).toEqual(Object.keys(EVENT_KINDS).sort());
  });

  it("gives each field the type, the requirement, and the values the parser holds it to", () => {
    const specs: [string, Readonly<Record<string, FieldSpec>>][] = [["common", COMMON_FIELDS], ...Object.entries(EVENT_KINDS)];
    for (const [section, fields] of specs) {
      const rows = english.get(section) ?? [];
      expect(rows.map((row) => row.field), section).toEqual(Object.keys(fields));
      for (const row of rows) {
        const spec = fields[row.field]!;
        expect(row.type, `${section}.${row.field}`).toBe(typeText(spec));
        expect(row.required === "yes", `${section}.${row.field}`).toBe(spec.required);
        for (const value of spec.values ?? []) expect(row.meaning, `${section}.${row.field}`).toContain(`\`${value}\``);
      }
    }
  });

  it("is paired with a Japanese file that lists the same fields of the same kinds", () => {
    const japanese = tables("docs/execution-events.ja.md");
    const fieldsOf = (found: Map<string, Row[]>) => Object.fromEntries([...found].map(([section, rows]) => [section, rows.map((row) => row.field)]));
    expect(fieldsOf(japanese)).toEqual(fieldsOf(english));
  });
});
