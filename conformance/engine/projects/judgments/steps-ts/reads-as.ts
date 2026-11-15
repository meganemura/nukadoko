import { defineStep, z } from "nukadoko";
import runGreet from "./run-greet.ts";

export default defineStep({
  pattern: "the greeting reads as {quality:string}",
  description: "The greeting, for a reader to judge against the quality",
  args: z.object({ quality: z.string().describe("What the greeting should read as"), stdout: runGreet.returns.shape.stdout }),
  from: { stdout: [runGreet, "stdout"] },
  claims: [{ actual: "stdout", view: "text", compare: "judged-as", expected: "quality" }],
});
