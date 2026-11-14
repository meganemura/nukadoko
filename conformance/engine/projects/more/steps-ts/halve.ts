import { defineStep, z } from "nukadoko";
import double from "./double.ts";

export default defineStep({
  description: "Halve a doubled number",
  pattern: "I halve the number {doubled:int}",
  args: z.object({ doubled: double.returns.shape.doubled }),
  returns: z.object({ half: z.number().describe("Half the number") }),
  from: { doubled: [double, "doubled"] },
  mutates: false,
  run({}, { doubled }) {
    return { half: doubled / 2 };
  },
});
