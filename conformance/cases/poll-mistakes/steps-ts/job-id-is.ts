import { defineStep, z } from "nukadoko";
import startJob from "./start-job.ts";

export default defineStep({
  pattern: "the job id is {wanted:string}",
  description: "Polls a value an earlier step returned, which never changes",
  args: z.object({ wanted: z.string().describe("The id expected"), id: startJob.returns.shape.id }),
  from: { id: [startJob, "id"] },
  poll: { timeout_ms: 1000 },
  claims: [{ actual: "id", compare: "equal", expected: "wanted" }],
});
