import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A todo's state reads as this text",
  pattern: "the todo {title:string} reads {expected:string}",
  args: z.object({
    title: z.string().describe("The todo's title"),
    expected: z.string().describe("The expected state"),
  }),
  observe({}, { title }) {
    return { value: title === "dust" ? "done" : "open" };
  },
  claims: [{ actual: "value", compare: "equal", expected: "expected" }],
});
