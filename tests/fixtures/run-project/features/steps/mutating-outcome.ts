import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `mutates` defaults to true; then-mutates.feature binds this in Then
// position, which `nuka run` must reject before executing it (docs/spec.md
// "Keyword semantics").
export default defineStep({
  pattern: "a mutating outcome exists",
  description: "Declares mutates: true; must never be legally bound in Then position",
  args: z.object({}),
  returns: z.object({}),
  async run() {
    return {};
  },
});
