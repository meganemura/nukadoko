import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import concurrentWrapperPart from "./concurrent-wrapper-part.js";
import fastPart from "./fast-part.js";

export default defineStep({
  description: "Calls a part that calls parts concurrently, beside another part",
  args: z.object({}),
  returns: z.object({ done: z.boolean() }),
  parts: [concurrentWrapperPart, fastPart],
  async run({ call }) {
    await Promise.all([call(concurrentWrapperPart, {}), call(fastPart, {})]);
    return { done: true };
  },
});
