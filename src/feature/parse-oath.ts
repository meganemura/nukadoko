import path from "node:path";
import { compile } from "@cucumber/gherkin";
import {
  IdGenerator,
  StepKeywordType,
  type DataTable,
  type Examples,
  type GherkinDocument,
  type Scenario,
  type Step,
  type TableRow,
} from "@cucumber/messages";
import type { ParsedFeature } from "./load-features.js";

// Responsibility: turn one Markdown oath into the same `GherkinDocument`
// plus pickles `parseFeatureSource` produces for a `.feature` file, so
// matching, `nuka check`, and `nuka run` never grow a second step model.
//
// Varar's own package is not imported. It plans steps and compares a
// sensor's return value to the words in the sentence, which would make
// Varar the measurer. Cucumber's Markdown token matcher is not used
// either: unmatched lines become a description there, and a description
// is dropped, which is the drift this front exists to report. Every
// sentence here becomes a step. A sentence no pattern matches is an
// undefined step later, on the line it was written on.
//
// The subset is deliberate and small. A `#` heading names the feature.
// Any later heading, and a line of three or more hyphens, starts a
// scenario. A blank line does not. A blockquote and a fenced code block
// are narration, not steps. A pipe table is the preceding step's data
// table (header row omitted: Markdown needs one, a Gherkin data table
// has no header), unless the scenario's step text already uses
// `<column>` placeholders that the header covers, in which case the
// table is Examples and `compile()` expands one pickle per body row.
// One sentence can hold one step. A sentence is not scanned for several
// patterns inside it. Doc strings, tags, and `@nukadoko:serial` are not
// read from Markdown.

export class OathParseError extends Error {
  readonly line: number | undefined;

  constructor(message: string, line?: number) {
    super(message);
    this.name = "OathParseError";
    this.line = line;
  }
}

const PLACEHOLDER = /<([A-Za-z_][A-Za-z0-9_]*)>/g;
const SEPARATOR_CELL = /^:?-+:?$/;
const RULE = /^\s*-{3,}\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(\s*)(`{3,})/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;

interface KeywordPeel {
  readonly keyword: string;
  readonly keywordType: StepKeywordType;
  readonly text: string;
}

const KEYWORDS: readonly { readonly word: string; readonly keywordType: StepKeywordType }[] = [
  { word: "Given", keywordType: StepKeywordType.CONTEXT },
  { word: "When", keywordType: StepKeywordType.ACTION },
  { word: "Then", keywordType: StepKeywordType.OUTCOME },
  { word: "And", keywordType: StepKeywordType.CONJUNCTION },
  { word: "But", keywordType: StepKeywordType.CONJUNCTION },
];

/**
 * Splits one line into sentences on `.` `!` `?` that sit outside double
 * quotes and are followed by whitespace or the end of the line. A run of
 * the same mark (`...`) is not a boundary: the mark is only a boundary
 * when it stands alone. The terminator itself is not part of the
 * sentence, so a pattern written without a trailing period still matches
 * a prose line that has one. Exported for the property tests; the parser
 * is the only production caller.
 */
export function splitSentences(line: string): readonly string[] {
  const sentences: string[] = [];
  let start = 0;
  let quotes = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && i + 1 < line.length) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      quotes += 1;
      continue;
    }
    if (quotes % 2 === 1) {
      continue;
    }
    if (ch !== "." && ch !== "!" && ch !== "?") {
      continue;
    }
    if (line[i - 1] === ch || line[i + 1] === ch) {
      continue;
    }
    const after = line[i + 1];
    if (after !== undefined && !/\s/.test(after)) {
      continue;
    }
    const sentence = line.slice(start, i).trim();
    if (sentence.length > 0) {
      sentences.push(sentence);
    }
    let next = i + 1;
    while (next < line.length && /\s/.test(line[next]!)) {
      next += 1;
    }
    start = next;
    i = next - 1;
  }
  const tail = line.slice(start).trim();
  if (tail.length > 0) {
    sentences.push(tail);
  }
  return sentences;
}

/**
 * Cells of one pipe-table row, or `undefined` when `line` is not a row.
 * A leading pipe is what makes a row, so a sentence that merely mentions
 * a pipe stays a sentence. `\|` is a literal pipe inside a cell.
 */
export function parseTableRow(line: string): readonly string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return undefined;
  }
  const body = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell));
}

function peelKeyword(text: string): KeywordPeel {
  for (const keyword of KEYWORDS) {
    const prefix = `${keyword.word} `;
    if (text.startsWith(prefix)) {
      return { keyword: prefix, keywordType: keyword.keywordType, text: text.slice(prefix.length) };
    }
  }
  return { keyword: "* ", keywordType: StepKeywordType.UNKNOWN, text };
}

function placeholdersIn(texts: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER)) {
      const name = match[1];
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return names;
}

interface BodyRow {
  readonly line: number;
  readonly cells: readonly string[];
}

interface MarkdownTable {
  readonly headerLine: number;
  readonly header: readonly string[];
  readonly rows: readonly BodyRow[];
}

interface DraftStep {
  readonly line: number;
  keyword: string;
  keywordType: StepKeywordType;
  text: string;
  table?: MarkdownTable;
}

interface DraftScenario {
  readonly line: number;
  readonly name: string;
  readonly steps: DraftStep[];
  examples?: MarkdownTable;
}

interface TableBuild {
  readonly headerLine: number;
  readonly header: readonly string[];
  readonly rows: BodyRow[];
  sawSeparator: boolean;
}

function stripInlineComment(line: string): { readonly text: string; readonly unclosed: boolean } {
  let text = "";
  for (let i = 0; i < line.length; i++) {
    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      if (end === -1) {
        return { text: text.trimEnd(), unclosed: true };
      }
      i = end + 2;
      continue;
    }
    text += line[i];
  }
  return { text, unclosed: false };
}

/**
 * Parses `source` as one oath. `relativePath` is the feature uri stored
 * on the document and the feature name when the file has no `#` heading.
 * Throws `OathParseError` on a table or fence this slice cannot read.
 * A file with no steps is a document with no pickles, not an error: the
 * caller decides whether an empty oath is worth running.
 */
export function parseOathSource(source: string, relativePath: string): ParsedFeature {
  const newId = IdGenerator.uuid();
  const lines = source.replace(/^\uFEFF/, "").split("\n");
  const scenarios: DraftScenario[] = [];
  const usedNames = new Set<string>();
  let featureName: string | undefined;
  let current: DraftScenario | undefined;
  let table: TableBuild | undefined;
  let fenceWidth = 0;
  let inComment = false;

  const fail = (message: string, line: number): never => {
    throw new OathParseError(message, line);
  };

  const closeScenario = (): void => {
    if (current !== undefined && current.steps.length > 0) {
      scenarios.push(current);
    }
    current = undefined;
  };

  const ensureScenario = (line: number, preferredName: string): DraftScenario => {
    if (current === undefined) {
      const name = allocateName(preferredName, usedNames);
      current = { line, name, steps: [] };
    }
    return current;
  };

  const attachTable = (built: MarkdownTable): void => {
    const scenario = current;
    if (scenario === undefined || scenario.steps.length === 0) {
      throw new OathParseError("a markdown table has no step before it", built.headerLine);
    }
    const names = placeholdersIn(scenario.steps.map((step) => step.text));
    const headerNames = new Set(built.header);
    const isExamples = names.size > 0 && [...names].every((name) => headerNames.has(name));
    if (isExamples) {
      if (scenario.examples !== undefined) {
        fail("a scenario already has an examples table", built.headerLine);
      }
      if (headerNames.size !== built.header.length) {
        fail("an examples table has a repeated column name", built.headerLine);
      }
      scenario.examples = built;
      return;
    }
    const last = scenario.steps[scenario.steps.length - 1]!;
    if (last.table !== undefined) {
      fail("a step already has a table", built.headerLine);
    }
    last.table = built;
  };

  const flushTable = (): void => {
    if (table === undefined) {
      return;
    }
    const built = table;
    table = undefined;
    if (!built.sawSeparator) {
      fail("a markdown table needs a separator row under the header", built.headerLine);
    }
    if (built.rows.length === 0) {
      fail("a markdown table has no data rows", built.headerLine);
    }
    attachTable({ headerLine: built.headerLine, header: built.header, rows: built.rows });
  };

  const addSentences = (lineNumber: number, text: string): void => {
    const peeled = text.trim().replace(LIST_MARKER, "");
    if (peeled.length === 0) {
      return;
    }
    for (const sentence of splitSentences(peeled)) {
      const keyword = peelKeyword(sentence);
      if (keyword.text.trim().length === 0) {
        fail("a step has no text after its keyword", lineNumber);
      }
      const scenario = ensureScenario(lineNumber, keyword.text.trim());
      scenario.steps.push({
        line: lineNumber,
        keyword: keyword.keyword,
        keywordType: keyword.keywordType,
        text: keyword.text.trim(),
      });
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const raw = lines[index]!.replace(/\r$/, "");

    if (fenceWidth > 0) {
      const fence = FENCE.exec(raw);
      if (fence !== null && fence[2]!.length >= fenceWidth) {
        fenceWidth = 0;
      }
      continue;
    }

    if (inComment) {
      const end = raw.indexOf("-->");
      if (end !== -1) {
        inComment = false;
        const rest = raw.slice(end + 3);
        if (rest.trim().length > 0) {
          addSentences(lineNumber, rest);
        }
      }
      continue;
    }

    const comment = stripInlineComment(raw);
    if (comment.unclosed) {
      inComment = true;
      if (comment.text.trim().length === 0) {
        continue;
      }
    }
    const line = comment.text;
    if (line.trim().length === 0) {
      flushTable();
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null && fence[1]!.length === 0) {
      flushTable();
      fenceWidth = fence[2]!.length;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushTable();
      continue;
    }

    const heading = HEADING.exec(line.trim());
    if (heading !== null) {
      flushTable();
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      if (level === 1 && featureName === undefined) {
        closeScenario();
        featureName = text.length > 0 ? text : featureName;
        continue;
      }
      closeScenario();
      const name = text.length > 0 ? text : "Example";
      usedNames.add(name);
      current = { line: lineNumber, name, steps: [] };
      continue;
    }

    if (RULE.test(line)) {
      flushTable();
      closeScenario();
      continue;
    }

    const cells = parseTableRow(line);
    if (cells !== undefined) {
      if (table === undefined) {
        table = { headerLine: lineNumber, header: cells, rows: [], sawSeparator: false };
        continue;
      }
      if (!table.sawSeparator) {
        if (!isSeparatorRow(cells)) {
          fail("a markdown table needs a separator row under the header", lineNumber);
        }
        if (cells.length !== table.header.length) {
          fail(
            `a markdown table separator has ${cells.length} cells and the header has ${table.header.length}`,
            lineNumber,
          );
        }
        table.sawSeparator = true;
        continue;
      }
      if (cells.length !== table.header.length) {
        fail(
          `a markdown table row has ${cells.length} cells and the header has ${table.header.length}`,
          lineNumber,
        );
      }
      table.rows.push({ line: lineNumber, cells });
      continue;
    }

    flushTable();
    addSentences(lineNumber, line);
  }

  if (fenceWidth > 0) {
    fail("a code fence is not closed", lines.length);
  }
  if (inComment) {
    fail("a comment is not closed", lines.length);
  }
  flushTable();
  closeScenario();

  const featureTitle = featureName ?? path.basename(relativePath, path.extname(relativePath));
  const gherkinDocument = buildDocument(relativePath, featureTitle, scenarios, newId);
  const pickles = compile(gherkinDocument, relativePath, newId);
  return { gherkinDocument, pickles };
}

function allocateName(preferred: string, used: Set<string>): string {
  const base = preferred.length > 80 ? `${preferred.slice(0, 77)}...` : preferred;
  const seed = base.length > 0 ? base : "Example";
  if (!used.has(seed)) {
    used.add(seed);
    return seed;
  }
  let n = 2;
  while (used.has(`${seed} (${n})`)) {
    n += 1;
  }
  const name = `${seed} (${n})`;
  used.add(name);
  return name;
}

function tableRow(cells: readonly string[], line: number, newId: IdGenerator.NewId): TableRow {
  return {
    id: newId(),
    location: { line, column: 1 },
    cells: cells.map((value) => ({ location: { line, column: 1 }, value })),
  };
}

function buildDocument(
  relativePath: string,
  featureName: string,
  scenarios: readonly DraftScenario[],
  newId: IdGenerator.NewId,
): GherkinDocument {
  return {
    uri: relativePath,
    comments: [],
    feature: {
      location: { line: 1, column: 1 },
      tags: [],
      language: "en",
      keyword: "Feature",
      name: featureName,
      description: "",
      children: scenarios.map((scenario) => ({ scenario: scenarioOf(scenario, newId) })),
    },
  };
}

function scenarioOf(scenario: DraftScenario, newId: IdGenerator.NewId): Scenario {
  const steps: Step[] = scenario.steps.map((step) => {
    const built: Step = {
      location: { line: step.line, column: 1 },
      keyword: step.keyword,
      keywordType: step.keywordType,
      text: step.text,
      id: newId(),
    };
    if (step.table !== undefined) {
      return { ...built, dataTable: dataTableFrom(step.table) };
    }
    return built;
  });
  const examples: Examples[] = [];
  if (scenario.examples !== undefined) {
    examples.push(examplesOf(scenario.examples, newId));
  }
  return {
    location: { line: scenario.line, column: 1 },
    tags: [],
    keyword: examples.length > 0 ? "Scenario Outline" : "Scenario",
    name: scenario.name,
    description: "",
    steps,
    examples,
    id: newId(),
  };
}

function dataTableFrom(table: MarkdownTable): DataTable {
  return {
    location: { line: table.rows[0]!.line, column: 1 },
    rows: table.rows.map((row) => tableRow(row.cells, row.line, IdGenerator.uuid())),
  };
}

function examplesOf(table: MarkdownTable, newId: IdGenerator.NewId): Examples {
  return {
    location: { line: table.headerLine, column: 1 },
    tags: [],
    keyword: "Examples",
    name: "",
    description: "",
    tableHeader: tableRow(table.header, table.headerLine, newId),
    tableBody: table.rows.map((row) => tableRow(row.cells, row.line, newId)),
    id: newId(),
  };
}
