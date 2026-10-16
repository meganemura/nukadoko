import { defineStep } from "nukadoko";
import { z } from "zod";

console.log("noisy-step loaded");

export default defineStep({
  pattern: "a noisy step exists",
  description: "logs when it is imported",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
