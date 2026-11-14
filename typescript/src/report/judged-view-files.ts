import type { JudgedView } from "../record/types.js";

// Responsibility: the files of a claim step's `judged_view` as the Allure
// results attach them to the step, each named for the page it shows. The
// cucumber-messages stream names the view in its claims attachment and
// embeds no file, as it embeds no other screenshot. It reads a step
// record's view, whose files are named from the step record's directory.
// Pure.

/** One file of a judged view to attach. */
export interface JudgedViewAttachment {
  /** `judged view` for the only page's screenshot, `judged view ARIA` for
   * its snapshot, and the page named in parentheses when several were
   * open: `judged view (page 1 of aki)`. */
  readonly name: string;
  /** Relative to the step record's directory. */
  readonly file: string;
  /** `image/png` for a screenshot; `text/plain` for an ARIA snapshot,
   * which every viewer shows as text where a YAML type may be offered
   * as a download. */
  readonly contentType: string;
}

/** Each file of `view`, page by page, a screenshot before its ARIA
 * snapshot, as the view took them. */
export function judgedViewAttachments(view: JudgedView | undefined): readonly JudgedViewAttachment[] {
  const pages = view?.pages ?? [];
  return pages.flatMap((page): JudgedViewAttachment[] => {
    const which = pages.length === 1 ? "" : ` (page ${page.page}${page.as === null ? "" : ` of ${page.as}`})`;
    return [
      ...(page.screenshot === null ? [] : [{ name: `judged view${which}`, file: page.screenshot.file, contentType: "image/png" }]),
      ...(page.aria === null ? [] : [{ name: `judged view ARIA${which}`, file: page.aria.file, contentType: "text/plain" }]),
    ];
  });
}
