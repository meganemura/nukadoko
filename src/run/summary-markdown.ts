// Responsibility: the Markdown escaping the run summary and the lines it
// shares with run.json write text through, so a step's text, an error
// message, or a word of the program's cannot end a table cell, close a
// code span early, or open an HTML tag. Boundary: pure string functions;
// what goes into a line is the caller's.

// Text a reader sees outside a code span. The table parser removes a `\`
// that sits immediately before a `|`, and the inline parser then removes a
// `\` that sits before ASCII punctuation, so a single `\` written for the
// pipe leaves `\\|`, which renders as `|`. Doubling every `\` first makes
// `\\\|` render as `\|`. `<` would open an HTML tag in GitHub's renderer.
export function cellText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;");
}

// A code span longer than any backtick run inside it, so an error message
// that quotes code cannot close it early. In a table, `|` still needs its
// backslash inside a code span. A code span shows any other `\` as itself,
// so those are left alone.
export function cellCode(text: string): string {
  return codeSpan(text).replace(/\|/g, "\\|");
}

// A code span outside a table, where a `\` before `|` would show.
export function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

export function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
