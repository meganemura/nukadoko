import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A float the line gives is this number",
  pattern: "the float {given:float} reads as {expected:string}",
  args: z.object({
    given: z.number().describe("The value the line gives"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: given };
  },
  claims: [{ actual: "value", compare: "equal", expected: "expected", expected_view: "json" }],
});
