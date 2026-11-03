import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileAtCommit, filesAtCommit, repositoryPlace, workingTreeFiles } from "./git-ref.js";
import { judgmentFileText, parseJudgmentFile, type JudgmentEntry } from "./judgments.js";

// Responsibility: where the judgments of a feature file live, reading and
// writing them, and, under `--base`, which of them changed since the ref
// (docs/spec.md "Judgments"). Boundary: the disk and git; what an entry
// means is src/run/judgments.ts's.
//
// The files sit in `judgments/` at the project root, one per feature file
// at the same relative path with `.json` added, outside the features
// directory on purpose: there every file is mapping, so a judgment added
// would make `--base` run each unchanged criterion again in the old world,
// when a judgment changes no step. Nor do they live in the run directory,
// which retention removes and nobody reviews: a judgment is committed, and
// the commit and its review are the record of who judged.

/** The directory, at the project root. */
export const JUDGMENTS_DIR = "judgments";

/** The judgment file of a feature file, relative to the project root,
 * with `/` separators. */
export function judgmentFileOf(feature: string): string {
  return `${JUDGMENTS_DIR}/${feature.split(path.sep).join("/")}.json`;
}

/** What a feature's judgment file holds: its entries, none when there is
 * no file, or why it could not be read. */
export function readJudgmentFile(rootDir: string, feature: string): { readonly entries: readonly JudgmentEntry[] } | { readonly problem: string } {
  let text: string;
  try {
    text = readFileSync(path.join(rootDir, judgmentFileOf(feature)), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    return { problem: `it could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  return parseJudgmentFile(text);
}

/** Writes a feature's judgment file whole, and returns its path relative
 * to the project root. */
export function writeJudgmentFile(rootDir: string, feature: string, entries: readonly JudgmentEntry[]): string {
  const relative = judgmentFileOf(feature);
  const file = path.join(rootDir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, judgmentFileText(entries));
  return relative;
}

/** Each judgment file the working tree and `baseCommit` hold with other
 * text, or one holds and the other does not, relative to the project
 * root and sorted. Throws a `GitRefError` when git does not answer. */
export async function changedJudgmentFiles(rootDir: string, baseCommit: string): Promise<string[]> {
  const { top, prefix } = await repositoryPlace(rootDir);
  const dir = prefix === "" ? `${JUDGMENTS_DIR}/` : `${prefix}/${JUDGMENTS_DIR}/`;
  const names = new Set([...(await workingTreeFiles(top)), ...(await filesAtCommit(top, baseCommit, dir))].filter((name) => name.startsWith(dir)));
  const changed: string[] = [];
  for (const name of names) {
    let now: string | null;
    try {
      now = readFileSync(path.join(top, name), "utf8");
    } catch {
      now = null;
    }
    if (now !== (await fileAtCommit(top, baseCommit, name))) changed.push(name.slice(prefix === "" ? 0 : prefix.length + 1));
  }
  return changed.sort();
}
