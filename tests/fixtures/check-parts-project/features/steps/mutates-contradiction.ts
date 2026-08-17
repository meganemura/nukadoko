import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import mutatingPart from "./mutating-part.js";

// Declares `mutates: false` while declaring a part that declares
// `mutates: true` — the contradiction docs/spec.md "Parts" says is always
// an error, on purpose, for `nuka check` to find.
export default defineStep({
  pattern: "a read-only step calls a mutating part",
  description: "declares mutates: false while declaring a mutating part, on purpose",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  parts: [mutatingPart],
  async run({ call }) {
    await call(mutatingPart, {});
    return {};
  },
});
