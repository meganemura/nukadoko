import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The helper is loaded with a dynamic import in the body, using the `.js`
// spelling a TypeScript ESM project writes for a `.ts` file. It resolves
// only while the TypeScript loader that discovery registered is still active.
export default defineStep({
  pattern: "a lazy greeting for {name:string} exists",
  description: "Return a greeting built by a helper that is imported inside the step body",
  args: z.object({ name: z.string() }),
  returns: z.object({ greeting: z.string() }),
  mutates: false,
  async run({}, args) {
    const { hello } = await import("./lib/lazy-helper.js");
    return { greeting: hello(args.name) };
  },
});
