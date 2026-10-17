import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import { formatId } from "./lib/format-id.js";

export default defineStep({
  pattern: "a project {string} exists",
  description: "Create a project and return its id",
  // @ts-expect-error `rationale` was removed; a step file that still passes it must run, and nuka check warns.
  rationale: "A leftover from a release that had rationale.",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run({}, args) {
    return { id: formatId("p", 1), name: args.name };
  },
});
