import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `schema-field-undescribed` target: CLI-only on purpose (no `pattern`), so
// this fixture's assertion for this finding stays about description alone
// rather than also tripping pattern-unbound. `args.label` has no
// `.describe()`; `returns.filed` does, proving the finding lists only the
// field actually missing one rather than flagging the whole schema.
export default defineStep({
  description: "File an item under a label",
  rationale: "CLI-only vocabulary; exists to give tests/tend.test.ts a schema-field-undescribed target without also touching pattern-unbound",
  args: z.object({ label: z.string() }),
  returns: z.object({ filed: z.boolean().describe("whether filing succeeded") }),
  async run() {
    return { filed: true };
  },
});
