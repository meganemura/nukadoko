import { defineStep, z } from "nukadoko";
import counted from "./open-todos-counted.ts";

export default defineStep({
  description: "The owner the count names",
  pattern: "the owner is {expected:string}",
  args: z.object({ expected: z.string().describe("The expected owner"), owner: counted.returns.shape.owner }),
  from: { owner: [counted, "owner"] },
  claims: [{ actual: "owner", compare: "equal", expected: "expected" }],
});
