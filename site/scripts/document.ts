// Cuts a Markdown document into its `## ` sections and finds its headings and links, all
// outside fenced code. Pure: no file is read here, so the cut can be tested on any text.
// It is not a Markdown parser: it knows fences, headings, inline code, and inline links,
// which is all the repository's documents use to point at one another.

export interface Section {
  /** The heading text, without the `## `. */
  heading: string;
  /** The lines under the heading, up to the next `## `. */
  lines: string[];
}

export interface Document {
  /** The `# ` heading's text, when the document opens with one. */
  title?: string;
  /** The lines before the first `## `, without the `# ` line. */
  intro: string[];
  sections: Section[];
}

/** Calls `visit` with each line and whether a fence holds it. A fence line itself counts as held. */
function eachLine(lines: string[], visit: (line: string, fenced: boolean) => void): void {
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && marker !== undefined) {
      fence = marker;
      visit(line, true);
    } else if (fence !== undefined) {
      visit(line, true);
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = undefined;
      }
    } else {
      visit(line, false);
    }
  }
}

export function parseDocument(text: string): Document {
  const doc: Document = { intro: [], sections: [] };
  let first = true;
  eachLine(text.split("\n"), (line, fenced) => {
    if (first && !fenced && line.startsWith("# ")) {
      doc.title = line.slice(2).trim();
      first = false;
      return;
    }
    first = false;
    if (!fenced && line.startsWith("## ")) {
      doc.sections.push({ heading: line.slice(3).trim(), lines: [] });
      return;
    }
    (doc.sections.at(-1)?.lines ?? doc.intro).push(line);
  });
  return doc;
}

/** The document again, line for line: the inverse of parseDocument. */
export function printDocument(doc: Document): string {
  const lines = [...(doc.title === undefined ? [] : [`# ${doc.title}`]), ...doc.intro];
  for (const section of doc.sections) lines.push(`## ${section.heading}`, ...section.lines);
  return lines.join("\n");
}

export interface Heading {
  depth: number;
  text: string;
}

/** The headings among the lines, outside fences, in order. */
export function headingsOf(lines: string[]): Heading[] {
  const found: Heading[] = [];
  eachLine(lines, (line, fenced) => {
    const match = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) found.push({ depth: match[1].length, text: match[2] });
  });
  return found;
}

/** Raises or lowers every heading outside fences by `by` levels, keeping each within 2 to 6. */
export function shiftHeadings(lines: string[], by: number): string[] {
  const out: string[] = [];
  eachLine(lines, (line, fenced) => {
    const match = fenced ? null : /^(#{2,6})(\s.*)$/.exec(line);
    out.push(match ? "#".repeat(Math.min(6, Math.max(2, match[1].length + by))) + match[2] : line);
  });
  return out;
}

/**
 * Replaces the target of each inline link outside fences and inline code. `rewrite` gets
 * the target as written and returns the new one.
 */
export function rewriteLinks(lines: string[], rewrite: (target: string) => string): string[] {
  const out: string[] = [];
  eachLine(lines, (line, fenced) => {
    if (fenced) {
      out.push(line);
      return;
    }
    // Odd pieces are inside backticks. A backtick run opens and the same run closes, so
    // splitting on single backticks is enough for the documents' `code` spans.
    const pieces = line.split(/(`+[^`]*`+)/);
    out.push(
      pieces
        .map((piece, i) =>
          i % 2 === 1 ? piece : piece.replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_, open, target, close) => open + rewrite(target) + close),
        )
        .join(""),
    );
  });
  return out;
}

/** Heading text as a reader sees it: no backticks, no link syntax, no emphasis marks. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .trim();
}

const japanese = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー。、，．！？：；）」』】〕";
const endsJapanese = new RegExp(`[${japanese}]$`, "u");
const opensBlock = /^\s*(?:[-*+]\s|\d+[.)]\s|#|\||<|>|`{3,}|~{3,}|$)/;

/**
 * Joins a Japanese sentence to the next line of the same paragraph. The Japanese documents
 * put one sentence on each line, and Markdown turns that line break into a space, which
 * Japanese text does not have between sentences. A line is joined only when it ends in a
 * Japanese character or full-width punctuation and the next line continues the paragraph:
 * not blank, not a new list item, heading, table row, or fence, and in a quote only when
 * both lines are quoted.
 */
export function joinJapaneseLines(lines: string[]): string[] {
  const out: string[] = [];
  let previousFenced = true;
  eachLine(lines, (line, fenced) => {
    const last = out.length - 1;
    if (!fenced && !previousFenced && last >= 0) {
      const prev = out[last];
      const quoted = /^\s*>\s?/;
      const prevQuote = quoted.exec(prev)?.[0];
      const quote = quoted.exec(line)?.[0];
      const body = quote !== undefined ? line.slice(quote.length) : line;
      const continues =
        endsJapanese.test(prev) &&
        !/ {2}$|\\$/.test(prev) &&
        // CommonMark does not close `**` after "。" when a letter follows it, so a line that
        // ends in emphasis keeps its break.
        !/[*_]$/.test(prev) &&
        !/^\s*(?:#|\|)/.test(prev.slice(prevQuote?.length ?? 0)) &&
        (prevQuote === undefined) === (quote === undefined) &&
        !opensBlock.test(body);
      if (continues) {
        out[last] = prev + body.trimStart();
        previousFenced = fenced;
        return;
      }
    }
    out.push(line);
    previousFenced = fenced;
  });
  return out;
}

export type Engine = "typescript" | "ruby";

const engineOfLanguage: Record<string, Engine> = { ts: "typescript", typescript: "typescript", ruby: "ruby", rb: "ruby" };

/**
 * How a code block in a document stands toward the two engines.
 * - `pair`: a `ruby` block followed, with only blank lines between, by a `ts` block, the
 *   same example in each engine. Alphabetical order, so neither engine comes first by rank.
 * - `only`: a block of one engine, under `<!-- engine: ruby -->` or `<!-- engine: typescript -->`.
 * - `neither`: code of the program under test, under `<!-- engine: neither -->`, such as a
 *   Rails initializer, which is Ruby but no step of either engine.
 * - `unpaired`: an engine's block with no pair and no marker. A neutral document should
 *   hold none; a document of one engine holds nothing else.
 */
export type EngineBlockKind = "pair" | "only" | "neither" | "unpaired";

export interface EngineBlock {
  /** 1-based line of the block's opening fence (the `ruby` one, for a pair). */
  line: number;
  /** 1-based line of the block's closing fence (the `ts` one, for a pair). */
  end: number;
  /** For a pair, the 1-based line of the `ts` block's opening fence. */
  second?: number;
  kind: EngineBlockKind;
  engine?: Engine;
}

const markerLine = /^\s*<!--\s*engine:\s*(typescript|ruby|neither)\s*-->\s*$/;

/** The engine code blocks of a document, in order. Blocks of other languages are not listed. */
export function engineBlocks(lines: string[]): EngineBlock[] {
  interface Fence {
    line: number;
    end: number;
    engine?: Engine;
    marker?: string;
    /** Only blank lines lie between the previous block's closing fence and this one. */
    followsBlock: boolean;
  }
  const fences: Fence[] = [];
  let fence: string | undefined;
  let lastText: string | undefined;
  let blankSinceClose = false;
  lines.forEach((line, i) => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === undefined) {
      if (marker) {
        const language = marker[2].trim().split(/\s+/)[0] ?? "";
        const named = markerLine.exec(lastText ?? "")?.[1];
        fences.push({ line: i + 1, end: lines.length, engine: engineOfLanguage[language], marker: named, followsBlock: blankSinceClose });
        fence = marker[1];
      } else if (line.trim() !== "") {
        lastText = line;
        blankSinceClose = false;
      }
    } else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === "") {
      fence = undefined;
      fences[fences.length - 1].end = i + 1;
      lastText = undefined;
      blankSinceClose = true;
    }
  });
  const blocks: EngineBlock[] = [];
  for (let i = 0; i < fences.length; i++) {
    const f = fences[i];
    if (f.engine === undefined) continue;
    if (f.marker === "neither") {
      blocks.push({ line: f.line, end: f.end, kind: "neither" });
    } else if (f.marker !== undefined) {
      blocks.push({ line: f.line, end: f.end, kind: "only", engine: f.marker as Engine });
    } else {
      const next = fences[i + 1];
      if (f.engine === "ruby" && next?.engine === "typescript" && next.followsBlock && next.marker === undefined) {
        blocks.push({ line: f.line, end: next.end, second: next.line, kind: "pair" });
        i++;
      } else {
        blocks.push({ line: f.line, end: f.end, kind: "unpaired", engine: f.engine });
      }
    }
  }
  return blocks;
}

/**
 * Wraps each pair, and each block of one engine, in HTML the site's engine switch reads:
 * a pair becomes two `data-engine` halves inside `.engine-pair`, so the reader's choice
 * hides one half; a block of one engine is labelled with it. Markdown inside an HTML block
 * needs a blank line on each side, which the wrapper gives. A page without JavaScript, and
 * GitHub, show both halves one after the other.
 */
export function wrapEngineBlocks(lines: string[]): string[] {
  const out = [...lines];
  // From the end, so the line numbers of the blocks not yet wrapped stay right.
  for (const block of engineBlocks(lines).reverse()) {
    const open = block.line - 1;
    const close = block.end - 1;
    if (block.kind === "pair") {
      const second = block.second! - 1;
      out.splice(close + 1, 0, "", "</div>", "</div>");
      out.splice(second, 0, "", "</div>", "<div data-engine=\"typescript\">", "");
      out.splice(open, 0, "<div class=\"engine-pair\">", "<div data-engine=\"ruby\">", "");
    } else if (block.kind === "only" && block.engine) {
      out.splice(close + 1, 0, "", "</div>");
      out.splice(open, 0, `<div class="engine-only" data-engine-only="${block.engine}">`, "");
    }
  }
  return out;
}
