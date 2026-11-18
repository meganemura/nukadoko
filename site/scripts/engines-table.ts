// Writes the table of what each engine offers, from docs/engines.json, between the
// `<!-- engines:begin -->` and `<!-- engines:end -->` lines of README.md and README.ja.md.
// The JSON is the one place the table is written, and conformance/engine/features/
// engines.feature holds it to each engine's help. `--check` writes nothing and fails when
// a README differs from what it would write, so CI catches a table edited by hand or a
// JSON change not carried over.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type Flags = string[] | null;
export interface EnginesTable {
  commands: Record<string, { ruby: Flags; typescript: Flags }>;
}

const words = {
  en: { command: "Command", missing: "not in this engine", without: (flags: string) => `all but ${flags}`, all: "yes" },
  ja: { command: "コマンド", missing: "このエンジンにはない", without: (flags: string) => `${flags} 以外のすべて`, all: "あり" },
};

/** One engine's cell: whether it has the command, and which of the other engine's flags it lacks. */
function cell(mine: Flags, other: Flags, locale: "en" | "ja"): string {
  const w = words[locale];
  if (mine === null) return w.missing;
  const lacking = (other ?? []).filter((flag) => !mine.includes(flag));
  return lacking.length === 0 ? w.all : w.without(lacking.map((f) => `\`${f}\``).join(locale === "ja" ? "、" : ", "));
}

export function renderTable(table: EnginesTable, locale: "en" | "ja"): string[] {
  const rows = Object.entries(table.commands).map(
    ([command, e]) => `| \`nuka ${command}\` | ${cell(e.ruby, e.typescript, locale)} | ${cell(e.typescript, e.ruby, locale)} |`,
  );
  return [`| ${words[locale].command} | Ruby | TypeScript |`, "| --- | --- | --- |", ...rows];
}

const begin = "<!-- engines:begin -->";
const end = "<!-- engines:end -->";

export function placeTable(text: string, table: string[]): string {
  const lines = text.split("\n");
  const from = lines.indexOf(begin);
  const to = lines.indexOf(end);
  if (from < 0 || to < from) throw new Error(`no ${begin} ... ${end} lines to write the table between`);
  return [...lines.slice(0, from + 1), ...table, ...lines.slice(to)].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const table = JSON.parse(readFileSync(join(repoDir, "docs/engines.json"), "utf8")) as EnginesTable;
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [file, locale] of [["README.md", "en"], ["README.ja.md", "ja"]] as const) {
    const path = join(repoDir, file);
    const before = readFileSync(path, "utf8");
    const after = placeTable(before, renderTable(table, locale));
    if (after === before) continue;
    if (check) {
      console.error(`${file}: the engines table differs from docs/engines.json\n  do: cd site && node scripts/engines-table.ts`);
      stale = true;
    } else {
      writeFileSync(path, after);
      console.log(`engines-table: wrote ${file}`);
    }
  }
  if (stale) process.exit(1);
}
