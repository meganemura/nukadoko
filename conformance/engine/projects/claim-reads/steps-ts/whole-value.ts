import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The value, as JSON",
  pattern: "the whole-value of {given:string} is {expected:string}",
  args: z.object({
    given: z.string().describe("The value observe reads, as JSON"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: JSON.parse(given) };
  },
  claims: [{ actual: "value", compare: "equal", expected: "expected", expected_view: "json" }],
});
