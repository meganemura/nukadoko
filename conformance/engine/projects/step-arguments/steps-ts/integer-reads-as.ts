import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "An integer the line gives is this number",
  pattern: "the integer {given:int} reads as {expected:string}",
  args: z.object({
    given: z.number().describe("The value the line gives"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: given };
  },
  claims: [{ actual: "value", compare: "equal", expected: "expected", expected_view: "json" }],
});
