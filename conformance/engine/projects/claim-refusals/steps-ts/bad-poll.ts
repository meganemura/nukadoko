import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "the badge is {text:string}",
  args: z.object({ text: z.string().describe("The text") }),
  observe() {
    return {};
  },
  claims: [{ actual: "badge", compare: "equal", expected: "text" }],
  poll: { timeout_ms: 0 },
});
