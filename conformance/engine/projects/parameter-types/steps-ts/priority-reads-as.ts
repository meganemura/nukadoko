import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A priority the line gives is this text",
  pattern: "優先度{given:priority}は{expected:string}と読む",
  args: z.object({
    given: z.string().describe("The priority the line gives"),
    expected: z.string().describe("The expected side"),
  }),
  observe({}, { given }) {
    return { value: given };
  },
  claims: [{ actual: "value", compare: "equal", expected: "expected" }],
});
