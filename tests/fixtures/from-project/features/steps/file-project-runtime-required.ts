import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// `projectId` is declared `.optional()`, so neither `nuka check`'s
// from-order guard nor `nuka run`'s own copy of it can flag this line: an
// optional key with no earlier binding is silent by design (docs/spec.md
// "Chaining steps"). The `superRefine` below adds a requirement no static
// check can see (a schema classifier only reads shape, never runs
// refinements). This proves the runtime zod parse really is the last
// line of defense for exactly this kind of schema, and that from's own
// hint still names the missing upstream when that parse fails on the key
// `from` was supposed to fill.
export default defineStep({
  pattern: "the project is filed, requiring projectId only at run time",
  description: "projectId is schema-optional but a superRefine requires it, so only from's runtime hint can name the missing upstream",
  args: z
    .object({ projectId: z.string().optional() })
    .superRefine((data, ctx) => {
      if (data.projectId === undefined) {
        ctx.addIssue({ code: "custom", path: ["projectId"], message: "projectId is required when from doesn't supply it" });
      }
    }),
  returns: z.object({ filed: z.boolean() }),
  from: { projectId: [createProject, "id"] },
  async run() {
    return { filed: true };
  },
});
