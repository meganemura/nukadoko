import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Destructuring `request` forces `ctx.request()` to run, which is enough on
// its own to make this session's own `dispose()` return a real (non-
// `undefined`) storageState to persist. No network call happens and no
// browser is launched.
export default defineStep({
  description: "Open a request context so this session has a storageState worth persisting at stop",
  args: z.object({}),
  returns: z.object({ touched: z.boolean() }),
  mutates: false,
  async run({ request }) {
    void request;
    return { touched: true };
  },
});
