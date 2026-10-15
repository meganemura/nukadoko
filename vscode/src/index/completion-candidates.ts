// Responsibility: turn extracted patterns into completion entries: a label
// that shows the pattern as declared, and a snippet whose text binds to it.
// A compat pattern given as a RegExp has no literal wording worth offering
// (there is no string a completion could insert that still means what the
// regexp matches), so those are dropped here; a "typed" pattern is always a
// cucumber-expression string already (src/step/define-step.ts's
// StepDefinitionInput), never a RegExp, so this filter only ever removes
// compat/regexp entries in practice.
import { basename } from "node:path";
import type { ExtractedPattern } from "../extraction/index.js";

export interface CompletionCandidate {
  readonly label: string;
  /** VS Code snippet syntax: one tab stop per parameter. */
  readonly snippet: string;
  readonly detail: string;
}

// Each default matches its built-in cucumber-expression type, so accepting
// the snippet unchanged gives a step line that binds. A custom parameter
// type is defined by code this extension never runs, so its stop holds the
// capture name or type name as a hint, which may not match.
const NUMERIC_DEFAULTS: Readonly<Record<string, string>> = {
  int: "1",
  byte: "1",
  short: "1",
  long: "1",
  biginteger: "1",
  float: "1.5",
  double: "1.5",
  bigdecimal: "1.5",
};

function escapeSnippetText(text: string): string {
  return text.replace(/[$}\\]/g, "\\$&");
}

function tabStop(index: number, type: string, name: string): string {
  const numeric = NUMERIC_DEFAULTS[type];
  if (numeric !== undefined) {
    return `\${${index}:${numeric}}`;
  }
  const fallback = type === "string" ? "text" : type === "word" ? "word" : type === "" ? "value" : type;
  const placeholder = `\${${index}:${escapeSnippetText(name.length > 0 ? name : fallback)}}`;
  return type === "string" ? `"${placeholder}"` : placeholder;
}

/** Index just past the end of the run that starts at `start`, stepping over
 * `\X` escapes; the run ends before the first character `isEnd` accepts. */
function skipUntil(pattern: string, start: number, isEnd: (ch: string) => boolean): number {
  let i = start;
  while (i < pattern.length && !isEnd(pattern[i]!)) {
    i += pattern[i] === "\\" ? 2 : 1;
  }
  return i;
}

// The cucumber-expression syntax this walks: `\X` is a literal X, `{...}` a
// parameter (`{name:type}` in a typed pattern), `(...)` optional text, which
// is left out, and `a/b` an alternation, of which the first alternative is
// kept. Both choices give text the expression still matches.
function toSnippet(pattern: string, kind: ExtractedPattern["kind"]): string {
  let snippet = "";
  let stops = 0;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      snippet += escapeSnippetText(pattern[i + 1]!);
      i += 2;
    } else if (ch === "{" && pattern.includes("}", i + 1)) {
      const end = pattern.indexOf("}", i + 1);
      const token = pattern.slice(i + 1, end);
      const colon = kind === "typed" ? token.indexOf(":") : -1;
      stops += 1;
      snippet += tabStop(stops, token.slice(colon + 1), colon === -1 ? "" : token.slice(0, colon));
      i = end + 1;
    } else if (ch === "(") {
      i = skipUntil(pattern, i + 1, (c) => c === ")") + 1;
    } else if (ch === "/") {
      i = skipUntil(pattern, i + 1, (c) => /\s/.test(c));
    } else {
      snippet += escapeSnippetText(ch);
      i += 1;
    }
  }
  return snippet;
}

export function buildCompletionCandidates(
  patterns: readonly ExtractedPattern[],
): readonly CompletionCandidate[] {
  const seen = new Set<string>();
  const candidates: CompletionCandidate[] = [];

  for (const pattern of patterns) {
    if (typeof pattern.pattern !== "string") {
      continue;
    }
    const label = pattern.pattern;
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    candidates.push({ label, snippet: toSnippet(label, pattern.kind), detail: basename(pattern.declarationFile) });
  }

  return candidates;
}
