import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listCheckCodes } from "../src/check/codes.js";
import { listAllCheckCodes } from "../src/cli/check.js";
import { runCli } from "../src/cli/run-cli.js";
import { REMOVED_TEND_CODES, TEND_CODES } from "../src/tend/types.js";
import { createCaptureSink, repoRoot } from "./helpers/fixtures.js";

// Responsibility: the names the reader-facing docs hand an agent (commands,
// flags, finding codes, and cross-referenced headings) exist in the CLI and
// in the files they point at. Each of these drifted once without any test
// failing: a skill named a tend code that was never registered, CLI messages
// and the spec cited a heading that had been renamed, and the spec's CLI
// summary left out commands and flags the CLI had.
//
// The truth is read from the CLI itself: the command tree and each command's
// flags from `nuka <path> --help` (yargs' own rendering of the tree runCli
// builds), the check codes from the registry `nuka check --codes` prints,
// and the tend codes from the set `nuka tend --fail-on` validates against.
//
// Extraction only reads explicit forms, so a hit always means a broken name:
// - a command is an inline code span, or a line in a fenced block, that
//   starts with `nuka ` (or `npx nuka `). Words after `nuka` are walked down
//   the command tree; every `--flag` up to a bare `--` must be one of that
//   command's own flags.
// - a finding code is a backticked lowercase kebab-case token whose first
//   word at least two registered codes start with (`fixture-...`,
//   `step-...`), plus every `--fail-on <code>` value. Other kebab-case
//   tokens (`setup-node`, `no-browser`) are not codes and are not read.
// - a heading is `see "X"` / `See "X"`, `<file>.md "X"`, `<file>.md's "X"`,
//   or, in Japanese, `「X」を参照` and `<file>.md の「X」`. X resolves when it
//   names a heading of the same file or of a Markdown file the paragraph
//   links to or names; a short form of a heading with a parenthetical
//   ("Compat steps" for "Compat steps (the migration door)") counts.
// - the CLI summary in docs/spec.md and docs/spec.ja.md has an entry for
//   every command, and each command's entries name each of its flags.
// - llms.txt names every command at least once, each subcommand included.
// Fenced blocks are not prose: only their `nuka` lines are read.

interface CommandNode {
  readonly flags: ReadonlySet<string>;
  readonly subcommands: ReadonlyMap<string, CommandNode>;
}

async function helpOf(commandPath: readonly string[]): Promise<string> {
  const logged: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logged.push(parts.join(" "));
  });
  try {
    const exitCode = await runCli([...commandPath, "--help"], {
      rootDir: repoRoot,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return logged.join("\n");
}

async function readCommandTree(commandPath: readonly string[] = []): Promise<CommandNode> {
  const help = await helpOf(commandPath);
  const flags = new Set<string>();
  const subcommands = new Map<string, CommandNode>();
  let section = "";
  for (const line of help.split("\n")) {
    if (/^\S.*:$/.test(line)) section = line;
    const flag = /^ {2}(?:-[a-zA-Z], )?--([a-z][a-z0-9-]*)/.exec(line);
    if (section === "Options:" && flag) flags.add(flag[1]!);
    const command = new RegExp(`^ {2}nuka ${commandPath.map((word) => `${word} `).join("")}([a-z][a-z-]*)`).exec(line);
    // The top level lists its commands under group headings ("Everyday:",
    // "Exploring:", ...) rather than one "Commands:" heading.
    if (section !== "Options:" && section !== "Positionals:" && command) {
      subcommands.set(command[1]!, await readCommandTree([...commandPath, command[1]!]));
    }
  }
  return { flags, subcommands };
}

function leafCommands(node: CommandNode, prefix: readonly string[] = []): Array<{ path: string[]; node: CommandNode }> {
  if (node.subcommands.size === 0) return [{ path: [...prefix], node }];
  return [...node.subcommands].flatMap(([name, child]) => leafCommands(child, [...prefix, name]));
}

interface DocFile {
  readonly relativePath: string;
  readonly text: string;
}

function markdownUnder(dir: string): string[] {
  return readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(relative);
    return entry.name.endsWith(".md") ? [relative] : [];
  });
}

const docFiles: DocFile[] = ["README.md", "README.ja.md", "llms.txt", ...markdownUnder("docs"), ...markdownUnder("skills")]
  .sort()
  .map((relativePath) => ({ relativePath, text: readFileSync(path.join(repoRoot, relativePath), "utf8") }));

const fencePattern = /^ *(```|~~~)[^\n]*\n[\s\S]*?^ *\1 *$/gm;

/** Prose paragraphs, fences removed, each paragraph's lines joined so a span
 * or a quote that wraps across lines is read whole. */
function paragraphsOf(text: string): string[] {
  return text
    .replace(fencePattern, "\n\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
}

function fencedLinesOf(text: string): string[] {
  return [...text.matchAll(fencePattern)].flatMap((match) => match[0].split("\n").slice(1, -1));
}

function nukaInvocations(file: DocFile): string[] {
  const fromSpans = paragraphsOf(file.text).flatMap((paragraph) =>
    [...paragraph.matchAll(/(?<!`)`(?:npx )?nuka ([^`]+)`(?!`)/g)].map((match) => match[1]!),
  );
  const fromFences = fencedLinesOf(file.text).flatMap((line) => {
    const match = /^\s*(?:\$ )?(?:npx )?nuka ([^#]*)/.exec(line);
    return match ? [match[1]!] : [];
  });
  return [...fromSpans, ...fromFences];
}

/** Why one `nuka ...` invocation names something the CLI does not have, or
 * undefined when every word it names exists. */
function invocationProblem(tree: CommandNode, invocation: string): string | undefined {
  const words = invocation.trim().split(/\s+/);
  let node = tree;
  const walked: string[] = [];
  let index = 0;
  for (; index < words.length; index++) {
    const word = words[index]!;
    const child = node.subcommands.get(word);
    if (child) {
      node = child;
      walked.push(word);
      continue;
    }
    if (node.subcommands.size > 0 && /^[a-z][a-z-]*$/.test(word)) {
      return `"${["nuka", ...walked].join(" ")}" has no command "${word}"`;
    }
    break;
  }
  for (const word of words.slice(index)) {
    if (word === "--") break;
    const flag = /^--([a-z][a-zA-Z0-9-]*)/.exec(word);
    if (!flag) continue;
    const name = flag[1]!;
    if (!node.flags.has(name) && !(name.startsWith("no-") && node.flags.has(name.slice(3)))) {
      return `"${["nuka", ...walked].join(" ")}" has no flag --${name}`;
    }
  }
  return undefined;
}

// Every code `nuka check --codes` prints: check, run, and refusal codes.
const allCodes = new Set([...listAllCheckCodes().map((entry) => entry.code), ...TEND_CODES]);
// The families come from the check and tend findings only: a run code such
// as `run-incomplete` would make every step named `run-...` read as a
// misspelled code.
const findingCodes = new Set([...listCheckCodes().map((entry) => entry.code as string), ...TEND_CODES]);
// A removed tend code is still a name the CLI answers to: `--fail-on` refuses
// it by name and says what replaced it, so an upgrade note may cite it.
const citableCodes = new Set([...allCodes, ...REMOVED_TEND_CODES.keys()]);
const familyOf = (code: string): string => code.split("-")[0]!;
// A first word counts as a family only when two or more codes share it, so
// `no-browser` is not read as a misspelled `no-step-files-found`.
const codeFamilies = new Set(
  [...findingCodes].map(familyOf).filter((family, _, all) => all.filter((other) => other === family).length > 1),
);

function codeProblems(file: DocFile): string[] {
  const problems: string[] = [];
  for (const paragraph of paragraphsOf(file.text)) {
    for (const match of paragraph.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) {
      const token = match[1]!;
      if (codeFamilies.has(familyOf(token)) && !citableCodes.has(token)) {
        problems.push(`\`${token}\` is not a check or tend code`);
      }
    }
  }
  for (const invocation of nukaInvocations(file)) {
    for (const match of invocation.matchAll(/--fail-on[ =]([a-z][a-z0-9-]*)/g)) {
      if (!TEND_CODES.has(match[1]!) && !REMOVED_TEND_CODES.has(match[1]!)) problems.push(`--fail-on ${match[1]} is not a tend code`);
    }
  }
  return problems;
}

function normalizeHeading(heading: string): string {
  return heading
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。]$/, "")
    .trim()
    .toLowerCase();
}

const headingCache = new Map<string, string[]>();

function headingsOf(relativePath: string): string[] {
  let headings = headingCache.get(relativePath);
  if (!headings) {
    const text = readFileSync(path.join(repoRoot, relativePath), "utf8").replace(fencePattern, "");
    headings = [...text.matchAll(/^#{1,6} (.+?)(?: #+)?$/gm)].map((match) => normalizeHeading(match[1]!));
    headingCache.set(relativePath, headings);
  }
  return headings;
}

function headingMatches(heading: string, quoted: string): boolean {
  return heading === quoted || heading.startsWith(`${quoted} (`) || heading.startsWith(`${quoted}(`);
}

/** Every existing Markdown file a paragraph links to or names, as
 * repository paths. A named file (`docs/spec.md`, `SKILL.md`) is looked up
 * from the repository root and from the citing file's directory upward. */
function referencedFiles(file: DocFile, paragraph: string): string[] {
  const fileDir = path.posix.dirname(file.relativePath);
  const linked = [...paragraph.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((match) =>
    path.posix.normalize(path.posix.join(fileDir, match[1]!)),
  );
  const ancestors = fileDir.split("/").map((_, index, parts) => parts.slice(0, parts.length - index).join("/"));
  const named = [...paragraph.matchAll(/(?<![\w/.-])((?:[\w-]+\/)*[\w.-]+\.md)\b/g)].flatMap((match) =>
    ["", ...ancestors].map((dir) => path.posix.join(dir, match[1]!)),
  );
  return [...new Set([...linked, ...named])].filter((candidate) => existsSync(path.join(repoRoot, candidate)));
}

function headingProblems(file: DocFile): string[] {
  const quotePatterns = [
    /\b[Ss]ee "([^"]+)"/g,
    /\.md`?(?:'s)? "([^"]+)"/g,
    /「([^」]+)」を参照/g,
    /\.md`?\)? ?の「([^」]+)」/g,
  ];
  const problems: string[] = [];
  for (const paragraph of paragraphsOf(file.text)) {
    const targets = [file.relativePath, ...referencedFiles(file, paragraph)];
    const headings = targets.flatMap(headingsOf);
    for (const pattern of quotePatterns) {
      for (const match of paragraph.matchAll(pattern)) {
        const quoted = normalizeHeading(match[1]!);
        if (!headings.some((heading) => headingMatches(heading, quoted))) {
          problems.push(`"${match[1]}" is not a heading of ${[...new Set(targets)].join(" or ")}`);
        }
      }
    }
  }
  return [...new Set(problems)];
}

function perFile(check: (file: DocFile) => string[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of docFiles) {
    const problems = check(file);
    if (problems.length > 0) found[file.relativePath] = problems;
  }
  return found;
}

/** The fenced block under the spec's "CLI summary" heading. */
function cliSummaryOf(relativePath: string): string {
  const text = readFileSync(path.join(repoRoot, relativePath), "utf8");
  const section = /^## CLI summary\n([\s\S]*?)^## /m.exec(text);
  expect(section).not.toBeNull();
  const block = /^```\n([\s\S]*?)^```$/m.exec(section![1]!);
  expect(block).not.toBeNull();
  return block![1]!;
}

/** The commands and flags a CLI summary block leaves out. An entry is a
 * line starting with `nuka ` plus the indented lines under it; a flag counts
 * as listed when one of its command's entries names it or its `--no-` form. */
function summaryOmissions(tree: CommandNode, summary: string): string[] {
  const entries = summary.split(/\n(?=nuka )/).filter((entry) => entry.startsWith("nuka "));
  const missing: string[] = [];
  for (const { path: commandPath, node } of leafCommands(tree)) {
    const name = ["nuka", ...commandPath].join(" ");
    const own = entries.filter((entry) => entry.startsWith(`${name} `) || entry.startsWith(`${name}\n`));
    if (own.length === 0) {
      missing.push(name);
      continue;
    }
    for (const flag of [...node.flags].sort()) {
      if (flag === "help" || flag === "version") continue;
      // A boolean flag that defaults to true is written the way it is used,
      // as its negation (`--no-check`).
      if (!own.some((entry) => new RegExp(`--(?:no-)?${flag}(?![\\w-])`).test(entry))) missing.push(`${name} --${flag}`);
    }
  }
  return missing;
}

/** The commands no `nuka ...` in the file names, down to each subcommand
 * (`nuka session clear`, `nuka skill path`). llms.txt is the one file an
 * agent may read alone, so it names each one. */
function commandOmissions(tree: CommandNode, file: DocFile): string[] {
  const named = nukaInvocations(file).map((invocation) => invocation.trim().split(/\s+/));
  return leafCommands(tree)
    .map(({ path: commandPath }) => commandPath)
    .filter((commandPath) => !named.some((words) => commandPath.every((word, index) => words[index] === word)))
    .map((commandPath) => ["nuka", ...commandPath].join(" "));
}

// A command or flag a release removed is still named by the upgrade notes
// that say what replaced it, and by their history. Only those two files may
// cite one.
const REMOVED_COMMANDS = new Set([
  "accept",
  "explore",
  "harvest",
  "mcp-tools",
  "experimental mcp-tools",
  "experimental webmcp-tools",
  "session start",
  "session stop",
]);
const REMOVED_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["init", new Set(["--env", "--env-files", "--base-url", "--features-dir"])],
  ["run", new Set(["--session"])],
  ["clean", new Set(["--records", "--cache", "--export"])],
  ["tend", new Set(["--all"])],
]);
const UPGRADE_NOTES = new Set(["docs/upgrading.md", "docs/upgrading.ja.md"]);

function citesRemovedCommand(file: DocFile, invocation: string): boolean {
  if (!UPGRADE_NOTES.has(file.relativePath)) return false;
  const words = invocation.trim().split(/\s+/);
  const firstTwo = words.slice(0, 2).join(" ");
  const removedFlags = REMOVED_FLAGS.get(words[0]!);
  return (
    REMOVED_COMMANDS.has(words[0]!) ||
    REMOVED_COMMANDS.has(firstTwo) ||
    words.slice(1).some((word) => removedFlags?.has(word) === true)
  );
}

// The newest upgrade section is the one a reader acts on today, so a removed
// command or flag it names has to sit in a bullet that says it is removed or
// refused. "`nuka clean --records` removes them now" once shipped there while
// the same section said `--records` exits 2. Older sections describe their
// release as it shipped; the note under "How to upgrade, every time" says
// the newest section wins.
const REMOVAL_WORDING = /\bremoved\b|\bexits? 2\b|\bis gone\b|削除|終了コード 2|2 で終了|なくなりました/;

function newestSectionOf(text: string): string {
  const sections = text.split(/^(?=## )/m).filter((section) => /^## \S*\d/.test(section));
  return sections[0] ?? "";
}

function removedCitationsWithoutRemoval(file: DocFile): string[] {
  const units = newestSectionOf(file.text)
    .replace(fencePattern, "\n\n")
    .split(/\n\s*\n|\n(?=- )/);
  return units.flatMap((unit) => {
    const cited = nukaInvocations({
      relativePath: file.relativePath,
      text: unit,
    }).filter((invocation) => citesRemovedCommand(file, invocation));
    if (cited.length === 0 || REMOVAL_WORDING.test(unit.replace(/\s+/g, " "))) return [];
    return cited.map((invocation) => `\`nuka ${invocation}\` is named as if it still worked`);
  });
}

describe("names in README.md, llms.txt, docs/, and skills/", () => {
  it("every `nuka ...` names a command and flags the CLI has", async () => {
    const tree = await readCommandTree();
    expect(
      perFile((file) =>
        nukaInvocations(file).flatMap((invocation) => {
          if (citesRemovedCommand(file, invocation)) return [];
          const problem = invocationProblem(tree, invocation);
          return problem ? [`\`nuka ${invocation}\`: ${problem}`] : [];
        }),
      ),
    ).toEqual({});
  });

  it.each([...UPGRADE_NOTES])("the newest section of %s names a removed command only as removed", (relativePath) => {
    const file = docFiles.find((candidate) => candidate.relativePath === relativePath)!;
    expect(removedCitationsWithoutRemoval(file)).toEqual([]);
  });

  it("every finding code is one nuka check or nuka tend reports", () => {
    expect(perFile(codeProblems)).toEqual({});
  });

  it("every quoted heading is a heading of the file it points at", () => {
    expect(perFile(headingProblems)).toEqual({});
  });

  it("llms.txt names every command and subcommand", async () => {
    const llms = docFiles.find((file) => file.relativePath === "llms.txt")!;
    expect(commandOmissions(await readCommandTree(), llms)).toEqual([]);
  });

  it.each(["docs/spec.md", "docs/spec.ja.md"])(
    "the CLI summary in %s lists every command and each of its flags",
    async (relativePath) => {
      expect(summaryOmissions(await readCommandTree(), cliSummaryOf(relativePath))).toEqual([]);
    },
  );
});

describe("the extraction itself", () => {
  it("lets only the upgrade notes cite a removed command", () => {
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "accept features/a.feature")).toBe(true);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.ja.md", text: "" }, "accept")).toBe(true);
    expect(citesRemovedCommand({ relativePath: "README.md", text: "" }, "accept features/a.feature")).toBe(false);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "acceptx")).toBe(false);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "experimental webmcp-tools <url>")).toBe(true);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "experimental explore a.ts")).toBe(false);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "init --env")).toBe(true);
    expect(citesRemovedCommand({ relativePath: "README.md", text: "" }, "init --env")).toBe(false);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "init --env-files")).toBe(true);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "run features/a.feature --session alice")).toBe(true);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "do open-cart --session alice")).toBe(false);
    expect(citesRemovedCommand({ relativePath: "docs/upgrading.md", text: "" }, "init --allure")).toBe(false);
  });

  // Positive controls: each drift named in this file's header, written as
  // the docs once had it, has to be reported, so a passing run above is not
  // an extraction that found nothing.
  const sample = (relativePath: string, text: string): DocFile => ({ relativePath, text });

  it("reports a command group named with a subcommand it does not have, and an unknown flag", async () => {
    const tree = await readCommandTree();
    expect(invocationProblem(tree, "skill install")).toBe('"nuka skill" has no command "install"');
    expect(invocationProblem(tree, "tend --fix")).toBe('"nuka tend" has no flag --fix');
    expect(invocationProblem(tree, "experimental explore features/m.ts --json -- --port 1")).toBe(undefined);
    expect(invocationProblem(tree, "run features/ --no-quiet")).toBe(undefined);
  });

  it("accepts any of a command's own flags, and names a flag it does not have, ignoring words after --", async () => {
    const tree = await readCommandTree();
    const leaves = leafCommands(tree);
    hegel.test((tc) => {
      const { path: commandPath, node } = tc.draw(gs.sampledFrom(leaves));
      const flags = tc.draw(gs.arrays(gs.sampledFrom([...node.flags]), { minSize: 0, maxSize: 4 }));
      const command = [...commandPath, "<arg>", ...flags.map((flag) => `--${flag}`)].join(" ");
      expect(invocationProblem(tree, command)).toBe(undefined);
      const unknown = tc.draw(gs.text({ minSize: 1, maxSize: 6, alphabet: "abcxyz" }));
      tc.assume(!node.flags.has(unknown));
      expect(invocationProblem(tree, `${command} -- --${unknown}`)).toBe(undefined);
      expect(invocationProblem(tree, `${command} --${unknown}=1`)).toBe(
        `"${["nuka", ...commandPath].join(" ")}" has no flag --${unknown}`,
      );
    });
  });

  it("reports a code in a registered family that is not registered, and leaves other kebab-case alone", () => {
    expect(
      codeProblems(
        sample(
          "skills/x.md",
          "`fixture-rot` and `fixture-unused` from `setup-node`.\n\n`nuka tend --fail-on step-missing`\n",
        ),
      ),
    ).toEqual(["`fixture-rot` is not a check or tend code", "--fail-on step-missing is not a tend code"]);
  });

  it("reports a removed flag the newest upgrade section names as if it still worked", () => {
    const text = [
      "## How to upgrade, every time\n\n- `nuka clean --export` is fine here.\n",
      "## 0.16.1 to the next release\n",
      "- **`nuka clean` takes `--dry-run` and `--json` only.** `nuka clean --records` exits 2.",
      "- **`run.json`.** Old runs stay; `nuka clean --records`\n  removes them now.",
      "",
      "## 0.10.1 to 0.11.0\n\n- `nuka clean --records` also removes runs.\n",
    ].join("\n");
    expect(removedCitationsWithoutRemoval(sample("docs/upgrading.md", text))).toEqual([
      "`nuka clean --records` is named as if it still worked",
    ]);
    expect(
      removedCitationsWithoutRemoval(
        sample(
          "docs/upgrading.ja.md",
          "## 0.16.1 から次のリリースへ\n\n- `nuka clean --records` を使えば今すぐ消せます。\n",
        ),
      ),
    ).toEqual(["`nuka clean --records` is named as if it still worked"]);
  });

  it("reports a quoted heading that the file it points at does not have", () => {
    expect(
      headingProblems(
        sample("docs/spec.md", 'Compat steps (see "What compat\nsteps lack") and see "Compat steps" and "Records".\n'),
      ),
    ).toEqual(['"What compat steps lack" is not a heading of docs/spec.md']);
    expect(headingProblems(sample("docs/spec.ja.md", "「Compat steps」を参照。「成果物」を参照。\n"))).toEqual([]);
  });

  it("reports a command or a subcommand llms.txt leaves out", async () => {
    const tree = await readCommandTree();
    const llms = docFiles.find((file) => file.relativePath === "llms.txt")!;
    const withoutClean = sample("llms.txt", llms.text.replace(/^- `nuka clean.*$/m, ""));
    expect(commandOmissions(tree, withoutClean)).toEqual(["nuka clean"]);
    const sessionOnly = sample("llms.txt", "`nuka session list` and `nuka session`\n");
    expect(commandOmissions(tree, sessionOnly).filter((name) => name.startsWith("nuka session"))).toEqual([
      "nuka session clear",
    ]);
  });

  it("reports a command or a flag the CLI summary leaves out", async () => {
    const tree = await readCommandTree();
    const summary = cliSummaryOf("docs/spec.md")
      .replace(/^nuka session clear .*$/m, "")
      .replaceAll("--concurrency", "");
    expect(summaryOmissions(tree, summary)).toEqual(["nuka run --concurrency", "nuka session clear"]);
  });
});
