import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The text the value starts with",
  pattern: "the text-start of {given:string} is {expected:string}",
  args: z.object({
    given: z.string().describe("The value observe reads, as JSON"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: JSON.parse(given) };
  },
  claims: [{ actual: "value", view: "text", compare: "starts-with-text", expected: "expected" }],
});
