import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Destructures `page` and touches it with no network needed
// (`page.setContent` alone is enough to prove a browser actually launched,
// the same reasoning as run-browser-project's own
// features/steps/touches-browser-directly.ts) — this fixture's only source
// of a real, measured `ScenarioRecord.browser`.
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
