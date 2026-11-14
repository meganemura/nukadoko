import { z } from "zod";
import { runTool } from "../../app/run-tool.js";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the tool gets {path:string}",
  description: "run a command-line tool that GETs a path of the program",
  args: z.object({ path: z.string() }),
  returns: z.object({ status: z.number(), traceparent: z.string() }),
  mutates: false,
  async run({ baseURL }, { path }) {
    return runTool(new URL(path, baseURL).href, {});
  },
});
