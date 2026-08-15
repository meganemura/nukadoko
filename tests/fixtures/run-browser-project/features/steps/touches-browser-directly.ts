import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Contrast case for tests/run-fixture-bag-browser.test.ts: destructures
// `page` and touches it —
// no network needed, `page.setContent` alone is enough to prove the browser
// actually launched — so that test's own `chromium.launch` spy has a real
// call to catch, proving the spy would fail a regression rather than pass
// vacuously (the same reason no-browser-touch.ts's own scenario needs a
// contrast case at all).
export default defineStep({
  pattern: "the step touches the browser directly",
  description: "Destructure page and set its content (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page }) {
    await page.setContent("<html><body>hi</body></html>");
    return { ok: true };
  },
});
