// Holds the documents to the rule that the two engines stand side by side. A document is
// neutral unless its path names an engine (docs/<engine>/, <engine>/README.md,
// skills/nukadoko/references/<engine>/). In a neutral document, an engine's code block is
// one half of a ruby-then-ts pair or sits under an `<!-- engine: ... -->` marker, and the
// words that name one engine's API or launcher stay out of the prose.
//
// The documents were written for the TypeScript engine first, so today they break both
// rules many times over. engines-ratchet.json holds each neutral document's counts, and
// this check fails when a count grows, never when it falls: a change may leave a document
// as it was or move it toward the rule, never away. `--write` records lower counts after a
// change has paired examples. The `.ja.md` pair of a document must show the same sequence
// of engine blocks as the English one, which holds already and so is not ratcheted.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { engineBlocks, parseDocument, type EngineBlock } from "./document.ts";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(siteDir, "..");
const ratchetPath = join(siteDir, "engines-ratchet.json");

/** Words that name one engine's API or launcher. Prose in a neutral document says `nuka`. */
const engineWords = ["defineStep", "z.object", "Nukadoko::Step", "npx nuka", "bundle exec nuka"];

export interface Counts {
  /** Engine code blocks with no pair and no marker. */
  unpaired: number;
  /** Uses of engineWords outside code blocks. */
  words: number;
}

function neutralDocuments(): string[] {
  const list = (dir: string) =>
    existsSync(join(repoDir, dir))
      ? readdirSync(join(repoDir, dir))
          .filter((f) => f.endsWith(".md") && !f.endsWith(".ja.md"))
          .map((f) => `${dir}/${f}`)
      : [];
  return [
    "README.md",
    "llms.txt",
    ...list("docs"),
    "skills/nukadoko/SKILL.md",
    ...list("skills/nukadoko/references"),
    "skills/nukadoko-verification/SKILL.md",
  ].sort();
}

function proseWords(lines: string[]): number {
  let fence: string | undefined;
  let count = 0;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && marker) fence = marker;
    else if (fence !== undefined) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else {
      for (const word of engineWords) count += line.split(word).length - 1;
    }
  }
  return count;
}

export function countsOf(text: string): Counts {
  const lines = text.split("\n");
  return { unpaired: engineBlocks(lines).filter((b) => b.kind === "unpaired").length, words: proseWords(lines) };
}

/** The blocks as a sequence of kinds, so a Japanese document can be compared with its English one. */
function shapeOf(blocks: EngineBlock[]): string {
  return blocks.map((b) => (b.engine ? `${b.kind}:${b.engine}` : b.kind)).join(" ");
}

const write = process.argv.includes("--write");
const ratchet: Record<string, Counts> = existsSync(ratchetPath) ? JSON.parse(readFileSync(ratchetPath, "utf8")) : {};
const now: Record<string, Counts> = {};
const problems: string[] = [];

for (const path of neutralDocuments()) {
  const text = readFileSync(join(repoDir, path), "utf8");
  now[path] = countsOf(text);
  const before = ratchet[path] ?? { unpaired: 0, words: 0 };
  for (const key of ["unpaired", "words"] as const) {
    if (now[path][key] > before[key]) {
      problems.push(
        `${path}: ${now[path][key]} ${key === "unpaired" ? "engine code blocks with no pair and no marker" : "engine words in prose"}, up from ${before[key]}\n` +
          `  because: a neutral document shows both engines side by side and says \`nuka\`\n` +
          (key === "unpaired"
            ? "  do: put the ruby block right before its ts twin, or mark the block with <!-- engine: ruby|typescript|neither -->"
            : `  do: move the sentence to docs/<engine>/, or say it without ${engineWords.join(", ")}`),
      );
    }
  }
  const jaPath = path.replace(/\.md$/, ".ja.md");
  if (path.endsWith(".md") && existsSync(join(repoDir, jaPath))) {
    const en = shapeOf(engineBlocks(text.split("\n")));
    const ja = shapeOf(engineBlocks(readFileSync(join(repoDir, jaPath), "utf8").split("\n")));
    if (en !== ja) {
      problems.push(`${jaPath}: engine blocks "${ja}" differ from ${path}'s "${en}"\n  because: a translation shows the same examples\n  do: pair and mark the blocks of ${jaPath} as ${path} does`);
    }
  }
}


// docs/ruby/ and docs/typescript/ hold one engine's side of the same pages: each file twinned
// names is in both directories, with the same `## ` headings in the same order,
// so a reader of one engine's page finds the other's answer under the same heading.
const engineDirs = ["docs/ruby", "docs/typescript"];
const twinned = ["reference.md", "reference.ja.md"];
for (const file of twinned) {
  const [ruby, ts] = engineDirs.map((dir) => `${dir}/${file}`);
  const missing = [ruby, ts].filter((p) => !existsSync(join(repoDir, p)));
  if (missing.length > 0) {
    problems.push(`${missing.join(", ")}: missing\n  because: each engine's page has a twin in the other engine's directory\n  do: write ${missing.join(" and ")} with the same \`## \` headings`);
    continue;
  }
  const headings = (p: string) => parseDocument(readFileSync(join(repoDir, p), "utf8")).sections.map((s) => s.heading);
  const [a, b] = [headings(ruby), headings(ts)];
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    problems.push(`${ruby} and ${ts}: \`## \` headings differ\n  ${ruby}: ${a.join(" / ")}\n  ${ts}: ${b.join(" / ")}\n  because: the two engines' pages are read side by side\n  do: give both files the same \`## \` headings in the same order`);
  }
}
if (write) {
  writeFileSync(ratchetPath, `${JSON.stringify(now, null, 2)}\n`);
  console.log(`check-engines: recorded the counts of ${Object.keys(now).length} neutral documents`);
} else if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
} else {
  const total = Object.values(now).reduce((sum, c) => ({ unpaired: sum.unpaired + c.unpaired, words: sum.words + c.words }), { unpaired: 0, words: 0 });
  console.log(`check-engines: ${total.unpaired} unpaired engine blocks and ${total.words} engine words left in neutral documents; none grew`);
}
