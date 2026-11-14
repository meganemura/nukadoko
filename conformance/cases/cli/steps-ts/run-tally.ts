import { defineStep, runCommand, z } from "nukadoko";
import { resolve } from "node:path";
import aCsvFileWith from "./a-csv-file-with.ts";
import anEmptyDirectory from "./an-empty-directory.ts";

const cli = resolve("src/cli.ts");

export default defineStep({
  description: "Run tally with these arguments in the directory an earlier step prepared",
  pattern: "I run tally with {argv:string}",
  args: z.object({
    argv: z.string().describe("Arguments after `tally`, separated by spaces"),
    dir: aCsvFileWith.returns.shape.dir,
  }),
  from: {
    dir: [[aCsvFileWith, "dir"], [anEmptyDirectory, "dir"]],
  },
  returns: z.object({
    exitCode: z.number().nullable().describe("The process exit code"),
    stdout: z.string().describe("Everything the process wrote to stdout"),
    stderr: z.string().describe("Everything the process wrote to stderr"),
  }),
  // Runs the program under test in a scratch directory a Given step made.
  mutates: false,
  async run({}, { argv, dir }) {
    return await runCommand(process.execPath, [cli, ...argv.split(/\s+/).filter((part) => part !== "")], { cwd: dir });
  },
});
