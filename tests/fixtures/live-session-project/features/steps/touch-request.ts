import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Destructuring `request` is the whole point of this step: it forces
// `ctx.request()` to run (src/context/create-context.ts's own
// `buildStepFixtures`), which is enough on its own to make
// `contextHandle.dispose()` return a real (non-`undefined`) storageState to
// persist — Playwright's `APIRequestContext.storageState()` always answers
// with something, even `{ cookies: [], origins: [] }`, once the context
// exists, whether or not any request was ever actually sent. No network
// call happens here and no browser is launched either.
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
