// Responsibility: the one line `observed.unmeasured` keeps for a process a
// step started through `node:child_process` instead of `runCommand`
// (docs/spec.md "Records"): the call, the program's name, and how many
// arguments it was given. Pure; channels.ts calls it after the call
// returned, so a call that threw names nothing.
//
// The arguments are left out. nukadoko did not measure the process, and a
// step passes a token it holds on a command line as easily as anywhere
// else, with no `redact` option on these calls to name it. The line goes
// into the step record and the run summary, so it must not be where such a
// token leaks to. The program keeps only its last path segment: the rest
// of a path says where it is installed, not what the step ran.

/** The words a shell would split `line` into, for counting only:
 * whitespace outside quotes separates words, single quotes keep
 * everything up to the next single quote, double quotes and a backslash
 * keep the next character. Not a shell parser: an operator such as `|`
 * counts as a word. */
export function shellWords(line: string): string[] {
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
    if (char === "\\" && index + 1 < line.length) {
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
    if (char === "'" || char === '"') {
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

function lastSegment(program: string): string {
  return program.split(/[\\/]/).pop() ?? program;
}

function isShell(options: unknown): boolean {
  return typeof options === "object" && options !== null && Boolean((options as { shell?: unknown }).shell);
}

/** `call` is the `node:child_process` function's name and `args` what it
 * was given. */
export function childProcessDetail(call: string, args: readonly unknown[]): string {
  const [first, second, third] = args;
  const list = Array.isArray(second) ? (second as unknown[]) : undefined;
  const commandLine = call === "exec" || call === "execSync" || isShell(list === undefined ? second : third);
  let program: string;
  let count: number;
  if (commandLine) {
    const words = shellWords(String(first));
    program = words[0] ?? "";
    count = words.length - 1 + (list?.length ?? 0);
  } else {
    program = first instanceof URL ? first.pathname : String(first);
    count = list?.length ?? 0;
  }
  return `${call} ${lastSegment(program)} with ${count} ${count === 1 ? "argument" : "arguments"}`;
}
