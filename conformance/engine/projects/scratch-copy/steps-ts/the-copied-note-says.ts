import { defineStep, z } from "nukadoko";
import copyTheSample from "./copy-the-sample.ts";

export default defineStep({
  description: "The note the copy holds is the text the line states",
  pattern: "the copied note says {text:string}",
  args: z.object({
    text: z.string().describe("The note the line expects"),
    note: copyTheSample.returns.shape.note,
  }),
  from: { note: [copyTheSample, "note"] },
  claims: [{ actual: "note", compare: "equal", expected: "text" }],
});
