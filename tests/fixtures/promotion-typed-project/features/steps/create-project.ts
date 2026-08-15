import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The "after" half of README's "Before / after" — same feature line as the
// sibling promotion-glue-project fixture's compat step
// (features/steps/create-project.ts there), promoted to a typed step: named
// capture instead of position capture, and a zod-validated `result` that
// tests/promotion-comparison.test.ts asserts against directly (the
// server response's extra, undeclared key gets stripped by the schema, not
// just passed through — that's what makes "validated" checkable here
// rather than only asserted).
export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/projects", { data: args });
    return res.json();
  },
});
