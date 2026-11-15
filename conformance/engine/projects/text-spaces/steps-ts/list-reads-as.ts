import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A text read through the comma-list view is this list",
  pattern: "the list {actual:string} reads as {expected:string}",
  args: z.object({
    actual: z.string().describe("The value read, with \\uXXXX for a character"),
    expected: z.string().describe("The expected list, as JSON"),
  }),
  observe({}, { actual }) {
    return { value: actual.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) };
  },
  claims: [{ actual: "value", view: "comma-list", compare: "equal", expected: "expected", expected_view: "json" }],
});
