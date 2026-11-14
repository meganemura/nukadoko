import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The value read equals another",
  pattern: "the value {actual:string} equals {other:string}",
  args: z.object({
    actual: z.string().describe("The value read, as text"),
    other: z.string().describe("The expected side"),
  }),
  observe({}, { actual }) {
    return { value: actual.replaceAll("\\n", "\n") };
  },
  claims: [{ actual: "value", view: "json", compare: "equal", expected: "other", expected_view: "json" }],
});
