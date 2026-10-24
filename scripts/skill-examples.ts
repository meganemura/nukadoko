// Responsibility: keep the nukadoko skill's worked examples true. Each
// example is a Markdown file under skills/nukadoko/references/examples/
// and a project under examples/acceptance/ that it was copied from. The
// project stays out of the npm tarball; the Markdown ships.
//
// Two checks, split by cost. tests/skill-examples.test.ts runs the static
// one in `npm test`: every gherkin and ts block in the Markdown is the whole
// content of one project file, and every feature file is quoted. Run
// directly (`npm run skill-examples`), this script runs the other one: it
// packs this checkout, installs the tarball into a copy of each project
// outside this repository, runs `nuka check` and `nuka run`, and compares
// their output with the transcript blocks in the Markdown. The comparison
// masks durations and reads a finding line only up to its file, because a
// `repeated-scenario-prefix` note's message quotes measured times.
//
// Run directly by Node (type stripping), so erasable syntax only and no
// relative imports.

import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Example {
  readonly markdown: string;
  readonly project: string;
}

export const EXAMPLES: readonly Example[] = ["cli", "http-api", "workflow"].map((shape) => ({
  markdown: `skills/nukadoko/references/examples/${shape}.md`,
  project: `examples/acceptance/${shape}`,
}));

/** The commands whose transcripts are replayed. Each example has to quote
 * every one, so a transcript cannot drop out of the check unnoticed. */
export const REPLAYED = ["npx nuka check", "npx nuka run"] as const;

/** The line that stands for any number of lines, none included. */
export const GAP = "...";

export interface Block {
  readonly info: string;
  readonly line: number;
  readonly body: string;
}

export function fencedBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^```(.*)$/.exec(lines[index]!);
    if (!open) continue;
    const start = index;
    const body: string[] = [];
    for (index += 1; index < lines.length && lines[index] !== "```"; index += 1) body.push(lines[index]!);
    blocks.push({ info: open[1]!.trim(), line: start + 1, body: body.map((line) => `${line}\n`).join("") });
  }
  return blocks;
}

export interface Transcript {
  readonly command: string;
  readonly expected: readonly string[];
}

/** Each `$ <command>` line of an unlabelled block, with the lines up to the
 * next `$` line as its expected output. */
export function transcripts(markdown: string): Transcript[] {
  const found: Transcript[] = [];
  for (const block of fencedBlocks(markdown)) {
    if (block.info !== "" || !block.body.startsWith("$ ")) continue;
    let current: { command: string; expected: string[] } | undefined;
    for (const line of block.body.slice(0, -1).split("\n")) {
      if (line.startsWith("$ ")) {
        current = { command: line.slice(2), expected: [] };
        found.push(current);
      } else {
        current!.expected.push(line);
      }
    }
  }
  return found;
}

/** A line as the comparison reads it: durations masked, and a finding line
 * (`note`, `warning`, `error`) cut after its file, since its message can
 * quote a measured time. */
export function normalizeLine(line: string): string {
  const finding = /^((?:note|warning|error)\t[^\t]+\t[^\t]+)\t/.exec(line);
  if (finding) return finding[1]!;
  return line.replace(/\(\d+s\)/g, "(Ns)").replace(/\b\d+\.\d+s\b/g, "N.Ns");
}

/** Null when `actual` matches `expected`, where a `...` line stands for any
 * run of lines; otherwise the first expected line that found no match. */
export function mismatch(expected: readonly string[], actual: readonly string[]): string | null {
  const want = expected.map((line) => (line === GAP ? GAP : normalizeLine(line)));
  const have = actual.map(normalizeLine);
  // furthest[i] is the deepest expected index reached; it names the line to
  // report when no alignment exists.
  let furthest = 0;
  const memo = new Map<string, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    furthest = Math.max(furthest, i);
    let result: boolean;
    if (i === want.length) result = j === have.length;
    else if (want[i] === GAP) result = match(i + 1, j) || (j < have.length && match(i, j + 1));
    else result = j < have.length && want[i] === have[j] && match(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  if (match(0, 0)) return null;
  return furthest < want.length ? `no line matches ${JSON.stringify(expected[furthest])}` : "output has more lines";
}

function projectFiles(root: string, project: string): Map<string, string> {
  const dir = path.join(root, project);
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    // What a local run of the project leaves behind is not part of it.
    if (/(^|\/)(node_modules|\.nukadoko)\//.test(file)) continue;
    files.set(file, readFileSync(path.join(dir, file), "utf8"));
  }
  return files;
}

/** What keeps an example's Markdown from matching its project's files: a
 * gherkin or ts block that is no project file's whole content, a feature
 * file no block quotes, or a replayed command with no transcript. */
export function staticDrift(root: string, example: Example): string[] {
  const markdown = readFileSync(path.join(root, example.markdown), "utf8");
  const files = projectFiles(root, example.project);
  const contents = new Set(files.values());
  const quoted = fencedBlocks(markdown).filter((block) => block.info === "gherkin" || block.info === "ts");
  const problems = quoted
    .filter((block) => !contents.has(block.body))
    .map((block) => `${example.markdown}:${block.line}: this ${block.info} block is not the content of any file in ${example.project}`);
  const bodies = new Set(quoted.map((block) => block.body));
  for (const [file, content] of files) {
    if (file.endsWith(".feature") && !bodies.has(content)) {
      problems.push(`${example.project}/${file}: no gherkin block in ${example.markdown} quotes it`);
    }
  }
  const commands = new Set(transcripts(markdown).map((transcript) => transcript.command));
  for (const command of REPLAYED) {
    if (!commands.has(command)) problems.push(`${example.markdown}: no transcript block for "$ ${command}"`);
  }
  return problems;
}

interface Ran {
  readonly code: number;
  readonly lines: string[];
}

function run(command: string, args: readonly string[], cwd: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      const lines = `${stdout}${stderr}`.split("\n");
      if (lines.at(-1) === "") lines.pop();
      resolve({ code: error ? (error.code as number) : 0, lines });
    });
  });
}

async function replay(root: string, tarball: string, scratch: string, example: Example): Promise<string[]> {
  const dir = path.join(scratch, path.basename(example.project));
  cpSync(path.join(root, example.project), dir, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|\.nukadoko)$/.test(source),
  });
  const install = await run("npm", ["install", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", tarball], dir);
  if (install.code !== 0) return [`${example.project}: npm install exited ${install.code}\n${install.lines.join("\n")}`];
  const nuka = path.join(dir, "node_modules", ".bin", "nuka");
  const markdown = readFileSync(path.join(root, example.markdown), "utf8");
  const problems: string[] = [];
  for (const transcript of transcripts(markdown)) {
    if (!(REPLAYED as readonly string[]).includes(transcript.command)) continue;
    const ran = await run(nuka, transcript.command.split(" ").slice(2), dir);
    const wrong = ran.code === 0 ? mismatch(transcript.expected, ran.lines) : `exited ${ran.code}`;
    if (wrong !== null) {
      problems.push(`${example.markdown}: "$ ${transcript.command}" ${wrong}. Its output was:\n${ran.lines.join("\n")}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // Outside this repository, so the tarball's own dependencies are all the
  // projects can resolve; scripts/pack-check.mjs explains the same choice.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "nukadoko-skill-examples-"));
  try {
    const packed = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
      cwd: root,
      encoding: "utf8",
    });
    const tarball = path.join(scratch, (JSON.parse(packed) as Array<{ filename: string }>)[0]!.filename);
    const problems = EXAMPLES.flatMap((example) => staticDrift(root, example));
    for (const example of EXAMPLES) problems.push(...(await replay(root, tarball, scratch, example)));
    if (problems.length > 0) {
      process.stderr.write(`${problems.join("\n\n")}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`skill-examples: ${EXAMPLES.length} examples match their transcripts\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
