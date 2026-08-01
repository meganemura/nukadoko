import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Used by lines.feature's two scenarios (each with a distinct `label`) to
// exercise `nuka run`'s `:line` scenario selection.
export default defineStep({
  pattern: "scenario {label:string} runs",
  description: "Records which scenario label actually ran",
  args: z.object({ label: z.string() }),
  returns: z.object({ label: z.string() }),
  mutates: true,
  async run(_ctx, args) {
    return { label: args.label };
  },
});
