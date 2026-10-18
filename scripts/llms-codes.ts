// Responsibility: rewrite the two finding-code tables in llms.txt from what
// the built CLI prints for `nuka check --codes --json` and
// `nuka tend --codes --json`. Boundary: only the lines between each table's
// begin marker and the next end marker change; everything else in the file
// is hand-written. tests/llms-codes.test.ts fails while a table differs from
// its registry, so run `npm run build && node scripts/llms-codes.ts` after
// adding, removing, or rewording a code.
//
// Run directly by Node (type stripping), so erasable syntax only and no
// relative imports. It reads the CLI's output rather than importing src/,
// which keeps the table equal to what a user's own `--codes` prints.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const END_MARKER = "<!-- /generated -->";

export interface CodeTable {
  readonly marker: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

// A backslash escapes itself and a pipe, the two characters a GFM table
// cell cannot hold as written.
function escapeCell(text: string): string {
  return text.replace(/[\\|]/g, (character) => `\\${character}`);
}

export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

function parseRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index]!;
    if (character === "\\" && index + 1 < line.length - 1) {
      cell += line[index + 1];
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** The body rows of the first table in `text`, header and rule left out. */
export function parseTable(text: string): string[][] {
  const lines = text.split("\n").filter((line) => line.startsWith("|") && line.endsWith("|"));
  return lines.slice(2).map(parseRow);
}

/** The text between `marker`'s line and the next end marker. */
export function readGenerated(text: string, marker: string): string {
  const lines = text.split("\n");
  const begin = lines.indexOf(marker);
  const end = lines.indexOf(END_MARKER, begin + 1);
  if (begin === -1 || end === -1) {
    throw new Error(`llms.txt has no "${marker}" ... "${END_MARKER}" block`);
  }
  return lines.slice(begin + 1, end).join("\n");
}

export function spliceGenerated(text: string, marker: string, body: string): string {
  const lines = text.split("\n");
  const begin = lines.indexOf(marker);
  const end = lines.indexOf(END_MARKER, begin + 1);
  if (begin === -1 || end === -1) {
    throw new Error(`llms.txt has no "${marker}" ... "${END_MARKER}" block`);
  }
  return [...lines.slice(0, begin + 1), body, ...lines.slice(end)].join("\n");
}

interface CheckCodeEntry {
  readonly code: string;
  readonly severity?: string;
  readonly description: string;
  readonly do: string;
}

interface TendCodeEntry {
  readonly code: string;
  readonly description: string;
  readonly do: string;
}

export function checkTable(entries: readonly CheckCodeEntry[]): CodeTable {
  return {
    marker: "<!-- generated: nuka check --codes --json -->",
    header: ["Code", "Severity", "Meaning", "Do"],
    rows: entries.map((entry) => [`\`${entry.code}\``, entry.severity ?? "-", entry.description, entry.do]),
  };
}

export function tendTable(entries: readonly TendCodeEntry[]): CodeTable {
  return {
    marker: "<!-- generated: nuka tend --codes --json -->",
    header: ["Code", "Meaning", "Do"],
    rows: entries.map((entry) => [`\`${entry.code}\``, entry.description, entry.do]),
  };
}

export function rewrite(text: string, tables: readonly CodeTable[]): string {
  return tables.reduce((current, table) => spliceGenerated(current, table.marker, renderTable(table.header, table.rows)), text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(root, "dist", "cli.js");
  const codes = (command: string) =>
    JSON.parse(execFileSync(process.execPath, [cli, command, "--codes", "--json"], { cwd: root, encoding: "utf8" })).codes;
  const file = path.join(root, "llms.txt");
  const before = readFileSync(file, "utf8");
  const after = rewrite(before, [checkTable(codes("check")), tendTable(codes("tend"))]);
  if (after === before) {
    process.stdout.write("llms.txt: code tables unchanged\n");
  } else {
    writeFileSync(file, after);
    process.stdout.write("llms.txt: code tables rewritten\n");
  }
}
