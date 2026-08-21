import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A real, executable twin of tests/external-use-run.test.ts's own inline
// `openCartStep` (pattern/args/returns kept identical by hand, same
// convention tests/external-record-step.test.ts already uses) — unlike
// that fixture's own steps, this one *is* executed, by `nuka run` against
// the harvested feature file that test writes, so `run` is real rather than
// a discovery-only stub.

const openCartReturns = z.object({ id: z.string() });

export default defineStep({
  pattern: "a cart is opened",
  description: "Open a new cart",
  args: z.object({}),
  returns: openCartReturns,
  mutates: true,
  async run({ request, requireEnv }) {
    const token = requireEnv("API_TOKEN");
    const res = await request.post(`/carts?token=${token}`);
    return openCartReturns.parse(await res.json());
  },
});
