import { defineStep, z } from "nukadoko";
import startJob from "./start-job.ts";

export default defineStep({
  pattern: "the job ends {status:string}",
  description: "The job an earlier step started reaches this status in GET /jobs/:id",
  args: z.object({
    status: z.string().describe("The status the job is expected to reach"),
    id: startJob.returns.shape.id,
  }),
  from: { id: [startJob, "id"] },
  async observe({ request }, { id }) {
    const res = await request.get(`/jobs/${id}`);
    const job = (await res.json()) as { status: string };
    return { status: job.status };
  },
  poll: { timeout_ms: 3000, settled: [{ actual: "status", compare: "not-equal", expected: { literal: "running" } }] },
  claims: [{ actual: "status", compare: "equal", expected: "status" }],
});
