import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the seeded db is used",
  description: "Destructures the process-scope user fixture seededDb and reports its own build count",
  args: z.object({}),
  returns: z.object({ count: z.number() }),
  mutates: false,
  async run({ seededDb }: any) {
    return { count: seededDb.count };
  },
});
