import type { JudgedView } from "../../record/types.js";

// Responsibility: where a Then's judged moment can be seen, as the run
// summary links it: the view of each open page right after the reading its
// claims were judged on (`judged_view`), or, for a Then that read no page,
// the requests its own step sent, whose responses are what `observe` read.
// A link, never the value: the summary's Claims entry already shows each
// value, and what a reader cannot get from it is the page around that
// value. It reads a run.json step that is already written; every path is
// the run directory's, as run.json names it. Pure.

/** One link the summary renders. */
export interface SeenLink {
  /** `page`, `page 2`, `page 1 of aki`, or that followed by ` ARIA`;
   * `responses` for a step's http.jsonl. */
  readonly label: string;
  /** Relative to the run directory, where summary.md is. */
  readonly href: string;
  /** How long after the judged reading the browser gave the file; absent
   * for a step's http.jsonl, which is no capture. */
  readonly afterReadingMs?: number;
}

/** What `seenLinks` reads of a run.json step. */
export interface SeenStep {
  readonly record: string | null;
  readonly observed?: { readonly http?: number | null } | null;
  readonly judged_view?: JudgedView;
  /** Present when the Then read a page in a run with a world. */
  readonly pages?: readonly unknown[];
}

/** Each place a Then's judged moment can be seen, page by page in
 * `judged_view`'s order, each page's screenshot before its ARIA snapshot,
 * since the screenshot was taken first and is what a person opens. A Then
 * that read no page and whose step sent requests gets its http.jsonl, and
 * one with neither gets none. */
export function seenLinks(step: SeenStep): readonly SeenLink[] {
  const pages = step.judged_view?.pages ?? [];
  const links = pages.flatMap((page): SeenLink[] => {
    const name = pages.length === 1 ? "page" : `page ${page.page}${page.as === null ? "" : ` of ${page.as}`}`;
    return [
      ...(page.screenshot === null ? [] : [{ label: name, href: page.screenshot.file, afterReadingMs: page.screenshot.after_reading_ms }]),
      ...(page.aria === null ? [] : [{ label: `${name} ARIA`, href: page.aria.file, afterReadingMs: page.aria.after_reading_ms }]),
    ];
  });
  // A Then that read a page is linked to its view or to nothing: the
  // requests its pages sent during the step are not what it read.
  if (step.judged_view !== undefined || step.pages !== undefined) return links;
  const http = step.observed?.http;
  if (step.record !== null && typeof http === "number" && http > 0) return [{ label: "responses", href: `${step.record.replace(/\/+$/, "")}/http.jsonl` }];
  return [];
}

/** A Markdown link to `href`, a path relative to the summary. The
 * destination is written in angle brackets, so a space in a path does not
 * end it; a destination that holds a character those brackets cannot hold
 * is written as a code span instead. A line break in either becomes a
 * space, so the link never ends the line it stands in. */
export function markdownLink(label: string, href: string): string {
  const text = label.replace(/[\r\n]/g, " ").replace(/[\\[\]]/g, (character) => `\\${character}`);
  if (/[<>\n\r]/.test(href)) return `${text} \`${href.replace(/[\r\n]/g, " ").replace(/`/g, "'")}\``;
  return `[${text}](<${href}>)`;
}

/** A capture taken at least this long after its reading says so beside its
 * link: a page that changes on a timer of a few hundred milliseconds (a
 * toast, a "Saving..." badge) can show another state by then. */
export const LATE_VIEW_MS = 100;
