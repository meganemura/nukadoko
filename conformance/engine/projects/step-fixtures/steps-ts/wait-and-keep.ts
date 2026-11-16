import { writeFile } from "node:fs/promises";
import { defineStep, z } from "nukadoko";
import makeATotal from "./make-a-total.ts";

export default defineStep({
  description: "Wait for the earlier total, then keep it as evidence",
  pattern: "the total is waited for and kept",
  args: z.object({}),
  returns: z.object({ total: z.number().int().describe("The total kept") }),
  // Writes only into its own evidence directory.
  mutates: false,
  async run({ section, poll, evidence, resultOf }) {
    section("waiting");
    let attempts = 0;
    const total = await poll(
      async () => {
        attempts += 1;
        return attempts >= 2 ? resultOf(makeATotal)?.total : undefined;
      },
      { description: "the total", interval: 10 },
    );
    await evidence.attach("total.txt", String(total));
    await writeFile(evidence.path("note.txt"), "kept");
    section("kept");
    return { total };
  },
});
