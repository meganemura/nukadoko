import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Trips all three kinds of page-origin evidence P0-page-events collects, in
// one browser launch: an inline <script> that calls console.error and a
// second that throws uncaught (weberror, the context-level counterpart to
// page.on("pageerror")), plus a page-issued fetch to an unreachable local
// port (requestfailed — nothing listens on 127.0.0.1:1, so the connection is
// refused almost immediately, no server or network access required). The
// token is embedded in both the console text and the failed request's URL
// so tests/page-events-receipt.test.ts can also prove redaction reaches
// page_events the same way it already reaches http.jsonl/receipt.json.
//
// Waits on the browser context's own events before returning, rather than
// trusting that setContent()/evaluate() resolving is enough time for them to
// have already fired: PageEventsCollector's own listener (browser-
// evidence.ts) is registered at context creation, well before this step
// ever runs, so by the time each of *these* listeners' promises resolves,
// the collector's has already run — same event, same tick, earlier
// registration.
export default defineStep({
  pattern: "a page logs an error, throws, and calls an unreachable host",
  description: "Trip a console error, an uncaught error, and a failed request (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page, requireEnv }) {
    const token = requireEnv("PAGE_TOKEN");
    const context = page.context();

    const consoleErrorSeen = context.waitForEvent("console", {
      predicate: (msg) => msg.type() === "error",
      timeout: 10_000,
    });
    const webErrorSeen = context.waitForEvent("weberror", { timeout: 10_000 });
    const requestFailedSeen = context.waitForEvent("requestfailed", { timeout: 10_000 });

    await page.setContent(
      `<script>console.error(${JSON.stringify(`console says ${token}`)});</script>` +
        `<script>throw new Error(${JSON.stringify(`uncaught says ${token}`)});</script>`,
    );
    await page.evaluate(async (t: string) => {
      try {
        await fetch(`http://127.0.0.1:1/${t}`);
      } catch {
        // Expected: nothing listens on this port. The context's own
        // `requestfailed` event, awaited below, is what this exists to
        // trigger.
      }
    }, token);

    await Promise.all([consoleErrorSeen, webErrorSeen, requestFailedSeen]);

    return { ok: true };
  },
});
