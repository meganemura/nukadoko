import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A text read through the text view is this text",
  pattern: "the text {actual:string} reads as {expected:string}",
  args: z.object({
    actual: z.string().describe("The value read, with \\uXXXX for a character"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { actual }) {
    return { value: actual.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) };
  },
  claims: [{ actual: "value", view: "text", compare: "equal", expected: "expected" }],
});
