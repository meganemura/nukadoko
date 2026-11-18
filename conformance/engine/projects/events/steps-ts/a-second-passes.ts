import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Wait one second",
  pattern: "a second passes",
  args: z.object({}),
  returns: z.object({}),
  // Waits only.
  mutates: false,
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {};
  },
});
