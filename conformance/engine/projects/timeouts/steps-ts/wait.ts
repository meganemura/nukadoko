import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Wait, under the project's stepTimeout",
  pattern: "it waits {ms:int} ms",
  args: z.object({ ms: z.number().describe("How long to wait") }),
  // Only waits.
  mutates: false,
  async run({}, { ms }) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return {};
  },
});
