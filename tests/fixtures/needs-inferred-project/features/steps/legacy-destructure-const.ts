import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Pre-migration shape, aliasing the whole first argument mid-body and then
// destructuring *that* (`const { page, section } = ctx`) instead of naming
// fixtures on `run`'s own first argument — the second recognized shape the
// extraction scan also catches, alongside plain and optional-chained
// member access. Never actually runs.
export default defineStep({
  pattern: "a legacy destructure const step runs",
  description: "Un-destructured first argument; destructures page and section from a const ctx alias in the body",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run(ctx, args) {
    void args;
    const { page, section } = ctx;
    void page;
    void section;
    return {};
  },
});
