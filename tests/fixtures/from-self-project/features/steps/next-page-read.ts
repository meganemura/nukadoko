import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A step that reads its own earlier result: the cursor of the page before.
// `from` can only name the step once the step exists, so the entry is added
// after defineStep returns.
const nextPageRead = defineStep({
  pattern: "the next page is read",
  description: "Read the page after the one this step read before",
  args: z.object({ cursor: z.string() }),
  returns: z.object({ cursor: z.string() }),
  mutates: false,
  async run({}, args) {
    return { cursor: `${args.cursor}+` };
  },
});
Object.assign(nextPageRead.from, { cursor: [nextPageRead, "cursor"] });

export default nextPageRead;
