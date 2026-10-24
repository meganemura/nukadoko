import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The one `from` producer this fixture uses — fully healthy on every axis
// the notes check (described fields including an optional one described
// *before* `.optional()` wraps it, a pattern a feature binds)
// so it never itself shows up in any finding.
export default defineStep({
  pattern: "a widget {name:string} is created",
  description: "Create a widget and return its id",
  args: z.object({
    name: z.string().describe("the widget's display name"),
    note: z.string().optional().describe("optional freeform note attached at creation"),
  }),
  returns: z.object({
    id: z.string().describe("the created widget's id"),
    name: z.string().describe("echoes the given name"),
  }),
  async run({}, args) {
    return { id: "w_0001", name: args.name };
  },
});
