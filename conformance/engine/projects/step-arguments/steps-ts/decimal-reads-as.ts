import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A bigdecimal the line gives is this text",
  pattern: "the decimal {given:bigdecimal} reads as {expected:string}",
  args: z.object({
    given: z.string().describe("The value the line gives"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: given };
  },
  claims: [{ actual: "value", compare: "equal", expected: "expected" }],
});
