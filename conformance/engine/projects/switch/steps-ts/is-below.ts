import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "One number is less than another",
  pattern: "{a:int} is below {b:int}",
  args: z.object({
    a: z.number().describe("The number read"),
    b: z.number().describe("The bound"),
  }),
  observe({}, { a }) {
    return { value: a };
  },
  claims: [{ actual: "value", compare: "less-than", expected: "b" }],
});
