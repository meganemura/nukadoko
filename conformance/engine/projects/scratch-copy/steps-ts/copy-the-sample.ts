import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Copy the sample directory into scratch and read its note back",
  pattern: "the sample is copied",
  args: z.object({}),
  returns: z.object({ note: z.string().describe("The note in the copy") }),
  // Writes only under scratch.
  mutates: false,
  async run({ scratch }) {
    const copy = await scratch.copy("sample");
    return { note: (await readFile(path.join(copy, "note.txt"), "utf8")).trim() };
  },
});
