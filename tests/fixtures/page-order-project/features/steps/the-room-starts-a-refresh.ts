import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Returns once the page sent the request, so it is this step's.
export default defineStep({
  pattern: "the room starts a refresh held back for {ms:int} ms",
  description: "make the room fetch /state, whose answer the program holds back for ms",
  args: z.object({ ms: z.number() }),
  returns: z.object({}),
  mutates: false,
  async run({ page }, { ms }) {
    await Promise.all([page.waitForRequest(/\/state\?hold=/), page.evaluate((hold) => (globalThis as unknown as { refresh(ms: number): void }).refresh(hold), ms)]);
    return {};
  },
});
