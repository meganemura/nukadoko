import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// docs/spec.md's "Typed steps" optional-group bullet, in the flesh: a
// parameter cannot sit inside cucumber-expressions' own optional-group
// syntax, but a custom type whose *own* regexp is optional is legal — this
// one pattern matches both "the items are listed" and "the items are
// listed from 'inventory'", folding what would otherwise be two step
// definitions (one per location-clause variant, the wp-cli/e-petitions pain
// parameter-types-design.md names) into one, paired with `dir`'s own
// `.optional()` args key.
export default defineStep({
  pattern: "the items are listed{dir:from-dir}",
  description: "List items, optionally scoped to a location clause",
  args: z.object({ dir: z.string().optional() }),
  returns: z.object({ items: z.array(z.string()), dir: z.string().optional() }),
  mutates: false,
  async run({}, args) {
    const items = args.dir ? [`item-in-${args.dir}`] : ["item-1", "item-2"];
    return { items, dir: args.dir };
  },
});
