import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The name of the user the value holds",
  pattern: "the name-field of {given:string} is {expected:string}",
  args: z.object({
    given: z.string().describe("The value observe reads, as JSON"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: JSON.parse(given) };
  },
  claims: [{ actual: "value.user.name", compare: "equal", expected: "expected" }],
});
