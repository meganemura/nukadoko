import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The counterpart to allocate-without-write.ts: a `evidence.path()`-
// allocated file that the step *does* write to must show up on the
// receipt, existence-confirmed by the executor rather than book-kept by
// this fixture itself (P9 task spec, scope item 2).
export default defineStep({
  pattern: "a step writes to its own allocated path",
  description: "Calls evidence.path, then writes to the path it returned",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence }) {
    const target = evidence.path("dump.csv");
    await writeFile(target, "a,b,c");
    return { ok: true };
  },
});
