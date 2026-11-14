import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Keeps a note",
  pattern: "a note is kept",
  args: z.object({}),
  returns: z.object({ note: z.string().describe("The note") }),
  mutates: false,
  run() {
    return { note: "hello" };
  },
});
