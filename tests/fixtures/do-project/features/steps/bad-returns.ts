import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Deliberately returns a value that fails its own `returns` schema:
// exercises `nuka do`'s "returns validation failed" step record path. The `as
// any` bypasses the type checker on purpose, same convention as
// invalid-config-project's fixture — the point is to prove the *runtime*
// returns check also catches this, not just the type checker.
export default defineStep({
  description: "Returns a value that fails its own returns schema",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  async run() {
    return {} as any;
  },
});
