import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "the reply is {text:string}",
  args: z.object({ text: z.string().describe("The text") }),
  observe() {
    return {};
  },
  claims: [{ actual: "reply", ar: "body", compare: "equal", expected: "text" }],
});
