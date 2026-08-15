import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// This step's own `run` is never reached: the `exploding` custom parameter
// type's transformer throws while
// matchPickleStep is still extracting the captured value, before this
// step's execution phase (and therefore its step record) even begins.
export default defineStep({
  pattern: "the {value:exploding} value is read",
  description: "Read a value through a custom parameter type that always throws",
  args: z.object({ value: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
