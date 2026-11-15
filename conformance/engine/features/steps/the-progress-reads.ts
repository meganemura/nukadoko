import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description:
    "What nuka wrote to stderr is exactly the docstring once each run id reads <run>, each record id <id>, and each duration <s>: a step's seconds and the whole run's time vary from run to run, and the rest is the text both engines print",
  pattern: "the progress reads",
  args: z.object({
    expected: z.string().describe("The stderr text, without its last newline"),
    stderr: nukaRuns.returns.shape.stderr,
  }),
  from: { stderr: [nukaRuns, "stderr"] },
  observe({}, { stderr }) {
    const progress = stderr
      .replace(/run-\d{8}-\d{6}-[a-z0-9]{4}/g, "<run>")
      .replace(/\b(step|scn)-\d{8}-\d{6}-[a-z0-9]{4}/g, "<id>")
      .replace(/\b\d+\.\d+s\b/g, "<s>")
      .replace(/\((?:\d+h )?(?:\d+m )?\d+s\)/g, "(<s>)");
    return { progress };
  },
  claims: [{ actual: "progress", view: "text", compare: "equal", expected: "expected" }],
});
