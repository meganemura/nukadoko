import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The text read matches this pattern",
  pattern: "the text {actual:string} matches {pattern:string}",
  args: z.object({
    actual: z.string().describe("The value read, with \\uXXXX for a character"),
    pattern: z.string().describe("The pattern, as JavaScript reads it"),
  }),
  observe({}, { actual }) {
    return { value: actual.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) };
  },
  claims: [{ actual: "value", compare: "matches", expected: "pattern" }],
});
