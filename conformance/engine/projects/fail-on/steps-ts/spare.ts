import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A step no line binds",
  pattern: "nothing binds this",
  args: z.object({}),
  run() {
    return {};
  },
});
