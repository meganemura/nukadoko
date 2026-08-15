import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Opens the browser but triggers none of the three page_events categories —
// the collector's own "nothing recorded" case, exercised at the step record
// level (P0-page-events task spec, completion condition 4): `page_events`
// must be entirely absent from this step record, not present-but-empty.
export default defineStep({
  description: "Open the browser and trigger nothing page_events would record (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page }) {
    await page.setContent("<html><body>quiet</body></html>");
    return { ok: true };
  },
});
