// Responsibility: the one line `observed.unmeasured` keeps for a process a
// step started through `node:child_process` instead of `runCommand`
// (docs/spec.md "Records"): the call, the program's name, and how many
// arguments it was given. Pure; channels.ts calls it once the call has
// started a process, so a call that threw on its arguments names nothing.
//
// The arguments are left out. nukadoko did not measure the process, and a
// step passes a token it holds on a command line as easily as anywhere
// else, with no `redact` option on these calls to name it. The line goes
// into the step record and the run summary, so it must not be where such a
// token leaks to. For the same reason a shell line's leading `NAME=value`
// assignments (`GITHUB_TOKEN=... gh api`) are not the program, and a
// program name with a `=` in it is not shown: no word of the line holds a
// `=`. The program keeps only its last path segment, split at either
// separator: the rest of a path says where it is installed, not what the
// step ran, and can hold a user name.

/** How a shell reads a command line into words, for counting only: a
 * POSIX shell (`/bin/sh`), or `cmd.exe` and the other Windows shells,
 * where `\` is a path separator and not an escape. */
export type ShellSyntax = "posix" | "windows";

/** The words a shell would split `line` into, for counting only:
 * whitespace outside quotes separates words. In a POSIX shell single
 * quotes keep everything up to the next single quote, and double quotes
 * and a backslash keep the next character. On Windows only double quotes
 * group, and a backslash is an ordinary character, so `C:\tools\x.exe` is
 * one word with its separators. Not a shell parser: an operator such as
 * `|` counts as a word. */
export function shellWords(line: string, syntax: ShellSyntax = "posix"): string[] {
  const posix = syntax === "posix";
  const words: string[] = [];
  let word = "";
  // A word can be empty (`''`), so "inside a word" is its own state.
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (posix && char === "\\" && index + 1 < line.length) {
      index += 1;
      word += line[index];
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else word += char;
      continue;
    }
    if (char === '"' || (posix && char === "'")) {
      quote = char;
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += char;
    inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}

/** A shell's leading `NAME=value` word, which sets a variable for the
 * program after it and is not the program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The last segment of `program`'s path, at either separator, so a
 * Windows path read on Linux, or the reverse, still loses its directories.
 * A trailing separator is dropped first, as `path.basename` does. */
export function programName(program: string): string {
  return program.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

function optionsOf(call: string, args: readonly unknown[]): unknown {
  const [, second, third] = args;
  if (call === "exec" || call === "execSync") return typeof second === "function" ? undefined : second;
  return Array.isArray(second) ? third : second;
}

function shellOf(options: unknown): unknown {
  return typeof options === "object" && options !== null ? (options as { shell?: unknown }).shell : undefined;
}

/** The syntax of the shell that reads a command line: Node's default
 * shell is `cmd.exe` on Windows and `/bin/sh` elsewhere, and an explicit
 * `shell` naming `cmd` is read as Windows on any platform. On Windows
 * every shell is read as Windows, Git Bash included: a Windows path in its
 * line is far more common than a backslash escape. */
export function shellSyntax(shell: unknown, platform: NodeJS.Platform): ShellSyntax {
  if (platform === "win32") return "windows";
  if (typeof shell === "string" && /^cmd(\.exe)?$/i.test(programName(shell))) return "windows";
  return "posix";
}

/** What the line shows as the program: its name, or a placeholder when it
 * is empty or holds a `=`. */
function shownProgram(program: string): string {
  const name = programName(program);
  if (name === "") return "(no program)";
  if (name.includes("=")) return "(name hidden: it holds an equals sign)";
  return name;
}

/** `call` is the `node:child_process` function's name, `args` what it
 * was given, and `platform` the one the call ran on (a parameter so a
 * test reads a Windows line on any machine). */
export function childProcessDetail(call: string, args: readonly unknown[], platform: NodeJS.Platform = process.platform): string {
  const [first, second] = args;
  const list = Array.isArray(second) ? (second as unknown[]) : undefined;
  const options = optionsOf(call, args);
  const shell = shellOf(options);
  const commandLine = call === "exec" || call === "execSync" || Boolean(shell);
  let program: string;
  let count: number;
  if (commandLine) {
    const words = shellWords(String(first), shellSyntax(shell, platform));
    let start = 0;
    while (start < words.length && ASSIGNMENT.test(words[start]!)) start += 1;
    program = words[start] ?? "";
    count = Math.max(words.length - start - 1, 0) + (list?.length ?? 0);
  } else {
    program = first instanceof URL ? first.pathname : String(first);
    count = list?.length ?? 0;
  }
  return `${call} ${shownProgram(program)} with ${count} ${count === 1 ? "argument" : "arguments"}`;
}
