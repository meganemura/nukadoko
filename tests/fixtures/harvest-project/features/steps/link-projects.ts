import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// Both `from` keys name the *same* upstream (create-project), reading the
// same `id` field — the one shape that makes a `used` entry's own presence
// insufficient to say *which* key it filled (categorize-args.ts's own
// header): a caller can chain one of the two through `--use` while setting
// the other directly via `--args`, and `used` cites create-project either
// way, since it did fill the first key.
export default defineStep({
  pattern: "projects are linked",
  description: "Link a primary and a secondary project id (both from create-project, or --use/--args)",
  args: z.object({ primaryId: z.string(), secondaryId: z.string() }),
  returns: z.object({ linked: z.boolean() }),
  from: { primaryId: [createProject, "id"], secondaryId: [createProject, "id"] },
  async run() {
    return { linked: true };
  },
});
