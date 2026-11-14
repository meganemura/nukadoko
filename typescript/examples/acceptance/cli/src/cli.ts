// tally: sum amounts per category from a CSV of `category,amount` lines.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  process.stderr.write("usage: tally <file.csv> [--json]\n");
  process.exit(1);
}
let text: string;
try {
  text = readFileSync(file, "utf8");
} catch {
  process.stderr.write(`tally: cannot read ${file}\n`);
  process.exit(2);
}
const totals = new Map<string, number>();
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  const [category, amount] = line.split(",");
  const n = Number(amount);
  if (!category || Number.isNaN(n)) {
    process.stderr.write(`tally: bad line: ${line}\n`);
    process.exit(3);
  }
  totals.set(category.trim(), (totals.get(category.trim()) ?? 0) + n);
}
const sorted = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
if (json) {
  process.stdout.write(JSON.stringify(Object.fromEntries(sorted)) + "\n");
} else {
  for (const [c, t] of sorted) process.stdout.write(`${c}: ${t}\n`);
}
