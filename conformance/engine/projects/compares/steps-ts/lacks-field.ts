import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The object read has no field of this name",
  pattern: "the object {actual:string} lacks the field {field:string}",
  args: z.object({
    actual: z.string().describe("The value read, as text"),
    field: z.string().describe("The expected side"),
  }),
  observe({}, { actual }) {
    return { value: actual.replaceAll("\\n", "\n") };
  },
  claims: [{ actual: "value", view: "json", compare: "lacks-field", expected: "field" }],
});
