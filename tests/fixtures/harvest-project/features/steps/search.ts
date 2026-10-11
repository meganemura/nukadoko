import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `query` is the only capture. `limit` is optional and `sort` carries a
// default, and neither is a capture, a chain, or a value a docstring or
// table on this line can bind. An exploration can still measure both.
// Harvest has to keep those measured values in the draft: dropping them
// makes a later run follow the schema (limit absent, sort "relevance")
// instead of the path that was explored.
export default defineStep({
  pattern: "I search for {query:string}",
  description: "Search with an optional limit and a defaulted sort",
  args: z.object({
    query: z.string(),
    limit: z.number().optional(),
    sort: z.string().default("relevance"),
  }),
  returns: z.object({ count: z.number() }),
  async run({}, args) {
    const limit = args.limit ?? 10;
    return { count: args.sort === "newest" ? limit : 10 };
  },
});
