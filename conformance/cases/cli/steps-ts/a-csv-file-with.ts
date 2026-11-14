import { defineStep, z } from "nukadoko";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default defineStep({
  description: "Write the docstring to a named file in a fresh scratch directory",
  pattern: "a file {name:string} with these lines",
  args: z.object({
    name: z.string().describe("The file name, relative to the scratch directory"),
    lines: z.string().describe("The file's contents, verbatim"),
  }),
  returns: z.object({
    dir: z.string().describe("The scratch directory the file was written in"),
    bytes: z.number().describe("Size of the file written, in bytes"),
  }),
  // Writes only inside the scenario's own scratch directory, which is removed after it.
  mutates: false,
  run({ scratch }, { name, lines }) {
    const dir = scratch.dir();
    const body = lines.endsWith("\n") ? lines : lines + "\n";
    writeFileSync(join(dir, name), body);
    return { dir, bytes: Buffer.byteLength(body) };
  },
});
