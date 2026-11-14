import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The value read is of this kind",
  pattern: "the value {actual:string} is a {kind:string}",
  args: z.object({
    actual: z.string().describe("The value read, as text"),
    kind: z.string().describe("The expected side"),
  }),
  observe({}, { actual }) {
    return { value: actual.replaceAll("\\n", "\n") };
  },
  claims: [{ actual: "value", view: "json", compare: "is-a", expected: "kind" }],
});
