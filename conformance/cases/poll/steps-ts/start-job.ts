import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a job named {name:string} is started and ends {ends:string}",
  description: "Start a job via POST /jobs that ends in the given status",
  args: z.object({
    name: z.string().describe("The job's name"),
    ends: z.string().describe('The status the job ends in: "done" or "failed"'),
  }),
  returns: z.object({ id: z.string().describe("The id the server assigned") }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/jobs", { data: { name: args.name, ends: args.ends } });
    const job = (await res.json()) as { id: string };
    return { id: job.id };
  },
});
