import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Deliberately returns a value that fails its own `returns` schema:
// exercises `nuka do`'s "returns validation failed" step record path. The `as
// any` bypasses the type checker on purpose, same convention as
// invalid-config-project's fixture — the point is to prove the *runtime*
// returns check also catches this, not just the type checker. The
// defaulted arg shows that the record keeps the args the step ran with,
// not the args the caller sent.
export default defineStep({
  description: "Returns a value that fails its own returns schema",
  args: z.object({ n: z.number().default(3) }),
  returns: z.object({ id: z.string() }),
  mutates: false,
  async run() {
    return {} as any;
  },
});
