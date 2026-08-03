import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A Step object that is never any file's own default export, so discovery
// can never register it (this fixture's own deterministic stand-in for the
// "reached through a different await import()" mistake docs/spec.md
// "Chaining steps" describes — see src/step/validate-from.ts's own header).
const neverDiscovered = defineStep({
  description: "not discovered on purpose — never exported as any file's default",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  run() {
    return { id: "phantom" };
  },
});

// CLI-only vocabulary (no `pattern` at all — docs/spec.md "Typed steps"
// allows this) for m6a-from-core task spec's own acceptance test: `from`
// naming an unregistered Step must refuse to execute at all, via `nuka do`.
export default defineStep({
  description: "from names a Step discovery never registered, on purpose (m6a-from-core fixture)",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean() }),
  from: { projectId: [neverDiscovered, "id"] },
  async run(_ctx, args) {
    return { archived: true };
  },
});
