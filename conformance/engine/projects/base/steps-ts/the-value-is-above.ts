import { defineStep, z } from "nukadoko";
import { existsSync, readFileSync } from "node:fs";

export default defineStep({
  description: "The number in value.txt, the program's one output, is greater than a bound",
  pattern: "the value is above {b:int}",
  args: z.object({ b: z.number().describe("The bound") }),
  observe() {
    // features/scale.txt, when there is one, is part of the mapping: it divides the value.
    const scale = existsSync("features/scale.txt") ? Number(readFileSync("features/scale.txt", "utf8").trim()) : 1;
    return { value: Math.trunc(Number(readFileSync("value.txt", "utf8").trim()) / scale) };
  },
  claims: [{ actual: "value", compare: "greater-than", expected: "b" }],
});
