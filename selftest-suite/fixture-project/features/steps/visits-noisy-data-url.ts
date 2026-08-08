import { z } from "zod";
import { defineStep } from "nukadoko";

// `page.goto("data:...")`, never `page.setContent(...)`: only `goto`
// produces an action the trace records (selftest-browser task spec,
// decision 2 -- measured, not assumed). `setContent` leaves no trace of its
// own, which is exactly why tests/fixtures/page-events-project's own
// quiet-page.ts (a different project) can use it for a step that only
// needs a quiet page; this step needs a `goto` action on top of the same
// three page_events categories that one already trips, so it has to
// navigate for real. No HTTP server for a page to visit either: a `data:`
// URL is the whole app, and selftest-suite already runs one server for the
// report itself and, in a different scenario, `allure watch`'s own -- a
// third one here would exist for no evidence a `data:` URL doesn't already
// provide.
//
// The `console.error` and the uncaught `throw` are this file's own,
// deterministic. The failed request is not just a failed request:
// Chromium logs its own "Failed to load resource" console message for a
// connection failure too (measured, writing this file), so `console_errors`
// reads 2 here, not 1. Nothing here or in selftest-suite's own Then step
// hardcodes that number -- the Then step reads whatever count this step's
// real receipt.json recorded and checks the report against that.
const html = [
  "<script>console.error('browser-evidence: console error')</script>",
  "<script>throw new Error('browser-evidence: uncaught error')</script>",
].join("");

export default defineStep({
  pattern: "the browser visits a data url that logs, throws, and fails a request",
  description: "Trip a console error, an uncaught error, and a failed request (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page }) {
    const context = page.context();
    const consoleErrorSeen = context.waitForEvent("console", {
      predicate: (message) => message.type() === "error",
      timeout: 10_000,
    });
    const webErrorSeen = context.waitForEvent("weberror", { timeout: 10_000 });
    const requestFailedSeen = context.waitForEvent("requestfailed", { timeout: 10_000 });

    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    await page.evaluate(async () => {
      try {
        await fetch("http://127.0.0.1:39217/browser-evidence");
      } catch {
        // Expected: nothing listens on this port. The context's own
        // `requestfailed` event, awaited below, is what this exists to
        // trigger.
      }
    });

    await Promise.all([consoleErrorSeen, webErrorSeen, requestFailedSeen]);
    return { ok: true };
  },
});
