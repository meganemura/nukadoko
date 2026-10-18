import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the banner reads {state:string}",
  description: "Fail unless the BANNER env value is the given state",
  args: z.object({ state: z.string() }),
  returns: z.object({}),
  mutates: false,
  run({ env }, { state }) {
    if (env.BANNER !== state) throw new Error(`the banner reads ${env.BANNER ?? "nothing"}, not ${state}`);
    return {};
  },
});
