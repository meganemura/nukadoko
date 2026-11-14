import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A positional first argument, never destructured — nukadoko needs the
// pattern itself to read fixture names from without calling `run`, and a
// positional parameter carries no such pattern to read. Never actually
// runs.
export default defineStep({
  pattern: "a not destructured step runs",
  description: "run()'s first argument is a bare identifier, not a destructuring pattern — never actually runs",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run(fixtures) {
    void fixtures;
    return {};
  },
});
