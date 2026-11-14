import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The object read has the expected fields",
  pattern: "the object {actual:string} has the fields {fields:string}",
  args: z.object({
    actual: z.string().describe("The value read, as text"),
    fields: z.string().describe("The expected side"),
  }),
  observe({}, { actual }) {
    return { value: actual.replaceAll("\\n", "\n") };
  },
  claims: [{ actual: "value", view: "json", compare: "has-fields", expected: "fields", expected_view: "json" }],
});
