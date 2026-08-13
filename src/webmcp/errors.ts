import type { Page } from "playwright";

// Responsibility: the one fact both halves of this experimental surface
// (list-tools.ts's A, call-tool.ts's B) need to check before asking their
// own question, because a missing API and an API that simply has nothing to
// report look identical from the outside otherwise: an empty tool list and
// "the page declares nothing" would print the same way, and a "no such
// tool" lookup failure and "there is no tool API to look anything up in"
// would both read the same. Conflating either pair would mean this surface
// fails silently in exactly the case it matters most, so both A and B call
// `assertWebmcpAvailable` first and let it throw its own, distinct error
// rather than falling through into either normal-looking case.

/**
 * Thrown by `assertWebmcpAvailable` when `navigator.modelContext` is not
 * present on the page it was given. Never thrown for "this page has zero
 * declared tools" (a normal, empty result) or "no tool by that name" (a
 * normal, named lookup failure): those are different facts, and each keeps
 * its own plain error.
 */
export class WebmcpNotAvailableError extends Error {
  constructor() {
    super(
      "navigator.modelContext is not present on this page. As of Chromium 149, Chromium exposes it " +
        "only when the browser is launched with --enable-features=WebMCPTesting (set browser.args in " +
        "nukadoko.config.ts). A missing flag is not the only possible cause: firefox and webkit can raise " +
        "this same error regardless of browser.args, since WebMCP is a Chromium-only feature today, " +
        "and so can a page loaded from a data: URL even under a correctly flagged Chromium, because " +
        "an opaque origin is not a secure context and the API is withheld there.",
    );
    this.name = "WebmcpNotAvailableError";
  }
}

/**
 * Checks `page` for `navigator.modelContext` and throws
 * `WebmcpNotAvailableError` when it is absent. A single, one-time read, the
 * same as `readDeclaredWebmcpTools` (list-tools.ts): a page that adds
 * `modelContext` after this call is not retried or waited for.
 */
export async function assertWebmcpAvailable(page: Page): Promise<void> {
  const available = await page.evaluate(
    () => typeof (navigator as { modelContext?: unknown }).modelContext !== "undefined",
  );
  if (!available) {
    throw new WebmcpNotAvailableError();
  }
}
