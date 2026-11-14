import { z } from "zod";
import { runTool } from "../../app/run-tool.js";
import { defineStep } from "../../nukadoko-shim.js";

// A trace id that is none of a world's.
const OWN = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

export default defineStep({
  pattern: "the tool gets {path:string} under a trace of its own",
  description: "run a command-line tool that GETs a path of the program with a TRACEPARENT the step chose",
  args: z.object({ path: z.string() }),
  returns: z.object({ status: z.number(), traceparent: z.string() }),
  mutates: false,
  async run({ baseURL }, { path }) {
    return runTool(new URL(path, baseURL).href, { TRACEPARENT: OWN });
  },
});
