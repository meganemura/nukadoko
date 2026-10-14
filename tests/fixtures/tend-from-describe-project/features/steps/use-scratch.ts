import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import makeScratch from "./make-scratch.js";

// `root` comes from a described producer field and stays unreported;
// `label` comes from an undescribed one, the control that must stay reported.
export default defineStep({
  description: "Read the scratch directory and label an earlier step returned",
  rationale: "CLI-only vocabulary; target for schema-field-undescribed on from-filled args",
  args: z.object({ root: z.string(), label: z.string() }),
  returns: z.object({}),
  from: { root: [makeScratch, "root"], label: [makeScratch, "label"] },
  async run() {
    return {};
  },
});
