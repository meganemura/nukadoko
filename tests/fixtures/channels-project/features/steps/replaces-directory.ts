import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Writes a file into a directory, then replaces the directory with a file:
// at the step's end the file it wrote sits under a file, so reading its
// identity fails with ENOTDIR.
export default defineStep({
  pattern: "a step replaces a directory it wrote into with a file",
  description: "Writes d/f, removes d, and writes d as a file",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  run({ scratch }) {
    const d = path.join(scratch.dir("paths"), "d");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "f"), "1");
    fs.rmSync(d, { recursive: true });
    fs.writeFileSync(d, "now a file");
    return { ok: true };
  },
});
