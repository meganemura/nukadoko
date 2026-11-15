import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The name of the user each row holds",
  pattern: "every row of {given:string} names {expected:string}",
  args: z.object({
    given: z.string().describe("The value observe reads, as JSON"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: JSON.parse(given) };
  },
  claims: [{ actual: "value.rows", each: { claims: [{ actual: "user.name", compare: "equal", expected: "expected" }] } }],
});
