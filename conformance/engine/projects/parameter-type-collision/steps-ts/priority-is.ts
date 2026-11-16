import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The priority is the one the line gives",
  pattern: "優先度は{expected:string}である",
  args: z.object({ expected: z.string().describe("The expected side") }),
  observe() {
    return { value: "high" };
  },
  claims: [{ actual: "value", compare: "equal", expected: "expected" }],
});
