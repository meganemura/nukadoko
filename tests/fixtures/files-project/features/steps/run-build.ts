import { z } from "zod";
import { defineStep, runCommand } from "../../nukadoko-shim.js";
import { projectDir } from "./project-dir.js";

// A stand-in for a build: "check" writes nothing, "migrate" adds a
// migration and a generated source file, "edit" changes a source file,
// and "clean" removes one.
const SCRIPT = `
const fs = require("node:fs");
const mode = process.argv[1];
if (mode === "migrate") {
  fs.mkdirSync("migrations", { recursive: true });
  fs.writeFileSync("migrations/0002_add_note.sql", "alter table notes add note text;\\n");
  fs.writeFileSync("src/generated.ts", "export {};\\n");
}
if (mode === "edit") fs.writeFileSync("src/index.ts", "export const version = 2;\\n");
if (mode === "clean") fs.rmSync("src/index.ts");
`;

export default defineStep({
  pattern: "the build runs with {mode:string}",
  description: "Runs the stand-in build in the project directory",
  args: z.object({ mode: z.enum(["check", "migrate", "edit", "clean"]).describe("What the build writes") }),
  returns: z.object({ exitCode: z.number().nullable().describe("The build's exit code") }),
  mutates: true,
  async run({}, { mode }) {
    const result = await runCommand(process.execPath, ["-e", SCRIPT, mode], { cwd: projectDir });
    return { exitCode: result.exitCode };
  },
});
