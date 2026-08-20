import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import takesANumber from "./takes-a-number.js";

// A pattern-bound composite whose own `ctx.call` succeeds normally, unlike
// every other `nuka run` scenario in this project: calls-mutating-part.ts's
// own read-only refusal never lets a part's own `run` start at all, and
// every other part-calling step here (project-with-member.ts and its own
// siblings) has no `pattern`, so `nuka run` can never reach it, only
// `nuka do` can. This step exercises the one shape neither of those covers:
// a part actually running to completion through the pickle/scenario path.
export default defineStep({
  pattern: "a numeric part is called through a scenario with n {n:int}",
  description: "Calls takes-a-number through a declared part and returns its doubled result",
  args: z.object({ n: z.number() }),
  returns: z.object({ doubled: z.number() }),
  parts: [takesANumber],
  async run({ call }, args) {
    const { doubled } = await call(takesANumber, { n: args.n });
    return { doubled };
  },
});
