import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// This task's spec's own required regression: pre-migration form of
// migrated-ground-truth.ts, right below in this same directory — its own
// `needs_inferred` must equal that step's `needs` exactly (this is the
// feature's whole reason to exist: a reader gets the same answer whether a
// step happened to migrate yet or not). Touches `page` and `env`. Never
// actually runs.
export default defineStep({
  pattern: "a legacy ground truth step runs",
  description: "Pre-migration twin of migrated-ground-truth — touches page and env — never actually runs",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run(ctx, args) {
    void args;
    void ctx.page;
    void ctx.env;
    return {};
  },
});
