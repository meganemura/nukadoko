import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import makeThing from "./make-thing.js";

export default defineStep({
  pattern: "the thing {name:string} is there",
  description: "Look at a thing",
  args: z.object({ name: z.string(), made: z.string() }),
  from: { made: [makeThing, "name"] },
  claims: [{ actual: "made", compare: "equal", expected: "name" }],
});
