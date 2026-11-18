import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineStep, runCommand, z } from "nukadoko";

export default defineStep({
  pattern: "the notes are written",
  description: "Runs a program that writes two notes and a readme in a new directory",
  args: z.object({}),
  returns: z.object({ exitCode: z.number().nullable().describe("The exit code") }),
  mutates: false,
  async run() {
    const { exitCode } = await runCommand(process.execPath, [resolve("lib/write.mjs")], { cwd: mkdtempSync(join(tmpdir(), "nukadoko-notes")) });
    return { exitCode };
  },
});
