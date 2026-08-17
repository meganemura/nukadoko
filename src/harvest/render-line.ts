import { parseCaptureToken, type Capture } from "../binding/capture.js";

// Responsibility: turn one step's pattern plus a `used`/`from`-independent
// value bag into the literal Gherkin text `nuka harvest` writes for a line,
// and the table/docstring block that follows it when one is needed
// (docs/spec.md "Harvesting"). This module only renders text — it never
// judges whether the result is right, that is what the round trip in
// src/harvest/build-draft.ts is for (docs/spec.md: "Rather than pick
// quietly, harvest reads every line it wrote back").
//
// `renderPatternLine` walks the pattern text itself rather than reusing
// src/binding/pattern.ts's `stripCaptureNames`: that function strips a
// `{key:type}` token down to bare `{type}` for the matcher to consume, and
// unescapes nothing, because the matcher wants cucumber-expressions syntax
// back. This module wants the opposite output — a capture's *value* in
// place of the token, and a literal character (not `\`+character) wherever
// the pattern escaped one — so it walks the same left-to-right, backslash-
// aware structure for a different destination. It shares `parseCaptureToken`
// (src/binding/capture.ts) so a capture's key/type text is parsed exactly
// one way project-wide.

export type PrimitiveArgs = Readonly<Record<string, unknown>>;

export interface RenderedLine {
  readonly ok: true;
  readonly text: string;
  readonly captures: readonly Capture[];
}

export interface RenderLineError {
  readonly ok: false;
  readonly message: string;
}

/** `string` is the one capture type cucumber-expressions requires quoting
 * for (`{string}` matches a quoted string); every other type — `int`,
 * `float`, a compat `word`, the anonymous type, or a custom parameter type
 * — is written bare via `String(value)`. Getting a custom type's own
 * textual form wrong is not this function's problem to solve: docs/spec.md
 * "Harvesting" puts that judgment on the round trip in build-draft.ts,
 * which reads every line back and names the ones that do not return the
 * args they came from. A per-type reverse table here would be a second
 * answer to a question that already has one.
 */
function formatCaptureValue(type: string, value: unknown): string {
  if (type === "string") {
    return JSON.stringify(typeof value === "string" ? value : String(value));
  }
  return String(value);
}

/**
 * Renders `pattern`'s literal text with each `{key:type}` capture replaced
 * by `args[key]`'s own textual form, and every `\X` escape resolved to the
 * literal `X` it stands for (docs/spec.md "Typed steps": a pattern's own
 * `\(`/`\)`/`\/` mean a literal character, not cucumber-expressions
 * syntax). Optional groups (`item(s)`) and alternation (`is/are`) are left
 * untouched in the output exactly as written — reversing either has no
 * single answer (docs/spec.md "Harvesting"), so this function never tries;
 * the round trip names a line that this choice broke.
 */
export function renderPatternLine(pattern: string, args: PrimitiveArgs): RenderedLine | RenderLineError {
  let text = "";
  const captures: Capture[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      text += pattern[i + 1];
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) {
        return { ok: false, message: `pattern "${pattern}" has an unterminated capture starting at "${pattern.slice(i)}"` };
      }
      let capture: Capture;
      try {
        capture = parseCaptureToken(pattern.slice(i + 1, end));
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      captures.push(capture);
      text += formatCaptureValue(capture.type, args[capture.key]);
      i = end + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  return { ok: true, text, captures };
}

/** Escapes a docstring content line for the closing separator collision
 * @cucumber/gherkin's own reader guards against: a content line that,
 * once left-trimmed, starts with `"""` is read as the *closing* separator,
 * not content (GherkinClassicTokenMatcher's own `match_DocStringSeparator`
 * checks `startsWith`, not "contains"). Prefixing that line's own leading
 * `"""` with `\` is what the reader's own `unescapeDocString` expects to
 * undo. A `"""` occurring mid-line is left alone: it can never be mistaken
 * for the separator, and escaping it too would ask the reader's own
 * single, non-global unescape to undo two occurrences on one line, which it
 * does not.
 */
function escapeDocStringLine(line: string): string {
  const trimmed = line.replace(/^[ \t]+/, "");
  if (!trimmed.startsWith('"""')) {
    return line;
  }
  const leadingWhitespace = line.slice(0, line.length - trimmed.length);
  return `${leadingWhitespace}\\${trimmed}`;
}

/** Escapes one table cell for @cucumber/gherkin's own reader
 * (GherkinLine's `getTableCells`): backslash first (so a cell's own `\`
 * never collides with the escape sequences introduced below it), then `|`
 * (a bare pipe would end the cell early), then an actual newline character,
 * written as the literal two-character sequence `\n` the reader turns back
 * into one. */
function escapeTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "\\n");
}

export interface DocStringAttachment {
  readonly kind: "docstring";
  readonly key: string;
  readonly value: string;
}

export interface TableAttachment {
  readonly kind: "table";
  readonly key: string;
  readonly value: readonly (readonly string[])[];
}

export type Attachment = DocStringAttachment | TableAttachment;

/**
 * Renders the table/docstring block that follows a step line, at
 * `indent` (the literal leading whitespace string every line of the block
 * gets — tests/fixtures/run-project/features/table.feature's own
 * convention: two spaces deeper than the step line it belongs to).
 */
export function renderAttachmentBlock(attachment: Attachment, indent: string): string[] {
  if (attachment.kind === "docstring") {
    const lines = attachment.value.split("\n").map((line) => `${indent}${escapeDocStringLine(line)}`);
    return [`${indent}"""`, ...lines, `${indent}"""`];
  }
  return attachment.value.map(
    (row) => `${indent}| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`,
  );
}
