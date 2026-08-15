import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Destructures `page` and touches it with no network needed
// (`page.setContent` alone is enough to prove a browser actually launched),
// the same reasoning as tests/fixtures/accept-condition-project's own
// features/steps/touches-browser.ts — this fixture's only source of a real,
// measured `ScenarioRecord.browser`. Shared by both inside.feature and
// outside.feature below (discoverSteps scans `featuresDir` for glue
// regardless of where a feature file itself lives).
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
