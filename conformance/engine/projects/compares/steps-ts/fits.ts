import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The output read fits the docstring",
  pattern: "the output {actual:string} fits",
  args: z.object({
    actual: z.string().describe("The value read, as text"),
    text: z.string().describe("The expected side"),
  }),
  observe({}, { actual }) {
    return { value: actual.replaceAll("\\n", "\n") };
  },
  claims: [{ actual: "value", compare: "fits-text", expected: "text" }],
});
