import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Deterministic failure, for a "red run" fixture (unrelated to the actual
// operation this project pretends to model).
export default defineStep({
  pattern: "the operation fails",
  description: "Always throws",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    throw new Error("the operation failed, as designed");
  },
});
