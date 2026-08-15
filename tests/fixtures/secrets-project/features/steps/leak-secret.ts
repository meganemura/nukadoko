import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Deliberately "leaks" env values straight into its own result and into an
// outbound request's query string — this is what tests/secrets.test.ts's
// integration test needs to prove that keeping a secret value out of
// record.json / stdout / http.jsonl is the *executor's* doing, not
// something a well-behaved step has to remember (docs/spec.md "Secrets":
// redaction is "applied by the executor at write time, never controllable
// from a step's run").
export default defineStep({
  description: "Echo env values into the result and an outbound request (test fixture only)",
  args: z.object({}),
  returns: z.object({ apiToken: z.string(), publicToken: z.string() }),
  mutates: false,
  async run({ request, env }) {
    const apiToken = env.API_TOKEN ?? "";
    const publicToken = env.PUBLIC_TOKEN ?? "";
    await request.get(`/echo?token=${apiToken}&public=${publicToken}`);
    return { apiToken, publicToken };
  },
});
