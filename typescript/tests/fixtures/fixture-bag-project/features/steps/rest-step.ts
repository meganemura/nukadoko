import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A rest property in the fixture destructuring — its own bound names
// aren't knowable without running the destructuring, which nukadoko must
// not do just to read what a step needs (docs/spec.md "Context API").
// Never actually runs.
export default defineStep({
  pattern: "a rest step runs",
  description: "Destructures ...rest instead of naming fixtures explicitly — never actually runs",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ ...rest }) {
    void rest;
    return {};
  },
});
