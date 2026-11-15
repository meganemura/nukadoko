import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The first tag the value holds",
  pattern: "the first-tag of {given:string} is {expected:string}",
  args: z.object({
    given: z.string().describe("The value observe reads, as JSON"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: JSON.parse(given) };
  },
  claims: [{ actual: "value", at: "tags.0", compare: "equal", expected: "expected" }],
});
