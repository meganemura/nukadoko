import { defineStep, z } from "nukadoko";
import aJobIsQueued from "./a-job-is-queued.ts";

export default defineStep({
  pattern: "the job performed {n:int} times",
  description: "The queued job performed this many times, as the job step's execution events say",
  args: z.object({ n: z.number().int().describe("How many times") }),
  events: { performed: { of: aJobIsQueued, count: { kind: "job", phase: "perform" } } },
  claims: [{ actual: "performed", compare: "equal", expected: "n" }],
});
