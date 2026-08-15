import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Post-migration twin of legacy-ground-truth.ts, right above in this same
// directory — same two fixtures (`page`, `env`), now properly destructured.
// A required regression test asserts this step's own
// `needs` equals legacy-ground-truth's `needs_inferred` exactly. Never
// actually runs.
export default defineStep({
  pattern: "a migrated ground truth step runs",
  description: "Post-migration twin of legacy-ground-truth — destructures page and env — never actually runs",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ page, env }, args) {
    void args;
    void page;
    void env;
    return {};
  },
});
