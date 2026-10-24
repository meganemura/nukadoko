import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A claim step whose observe stands in for reading a greeting.
export default defineStep({
  pattern: "a greeting to {name:string}",
  description: "Greet someone",
  args: z.object({ name: z.string() }),
  async observe() {
    return { greeted: "world" };
  },
  claims: [{ actual: "greeted", compare: "equal", expected: "name" }],
});
