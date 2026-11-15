import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Every row whose score is over 10 scores at least 5",
  pattern: "every row of {given:string} with a score over 10 scores at least 5",
  args: z.object({ given: z.string().describe("The value observe reads, as JSON") }),
  observe({}, { given }) {
    return { value: JSON.parse(given) };
  },
  claims: [
    {
      actual: "value.rows",
      each: {
        where: [{ actual: "score", compare: "greater-than", expected: { literal: 10 } }],
        claims: [{ actual: "score", compare: "at-least", expected: { literal: 5 } }],
      },
    },
  ],
});
