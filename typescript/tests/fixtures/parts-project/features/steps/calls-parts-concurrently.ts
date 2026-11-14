import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import fastPart from "./fast-part.js";
import slowPart from "./slow-part.js";

export default defineStep({
  description: "Calls two declared parts at the same time",
  args: z.object({}),
  returns: z.object({ orders: z.array(z.string()) }),
  parts: [slowPart, fastPart],
  async run({ call }) {
    const results = await Promise.all([call(slowPart, {}), call(fastPart, {})]);
    return { orders: results.map((result) => result.order) };
  },
});
