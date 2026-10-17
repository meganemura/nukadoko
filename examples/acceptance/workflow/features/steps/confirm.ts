import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
import register from "./register.ts";

export default defineStep({
  description: "Open the confirmation link the registration issued",
  pattern: "the confirmation link is opened",
  args: z.object({ token: register.returns.shape.token }),
  from: { token: [register, "token"] },
  returns: z.object({ email: z.string().nullable().describe("The email the token confirmed") }),
  run({ store }, { token }) {
    assert.ok(token, "the registration issued no token, so there is no link to open");
    return { email: store.confirm(token).email };
  },
});
