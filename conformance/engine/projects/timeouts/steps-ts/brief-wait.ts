import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Wait, under a timeout of its own",
  pattern: "it waits briefly for {ms:int} ms",
  args: z.object({ ms: z.number().describe("How long to wait") }),
  timeout: 100,
  // Only waits.
  mutates: false,
  async run({}, { ms }) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return {};
  },
});
