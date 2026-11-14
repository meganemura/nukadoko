import { defineStep, runCommand, z } from "nukadoko";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildProject } from "./lib/engine.ts";

export default defineStep({
  description: "Copy a project as the-project does, into a git repository of its own with one commit holding every file",
  pattern: "the project {name:string} in a git repository",
  args: z.object({
    name: z.string().describe("The project's directory name under conformance/engine/projects"),
  }),
  returns: z.object({
    dir: z.string().describe("The scratch directory that holds the project and its repository"),
  }),
  // Writes only inside the scenario's own scratch directory, which is removed after it.
  mutates: false,
  async run({ scratch }, { name }) {
    const dir = scratch.dir();
    buildProject(name, dir);
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.nukadoko/\n");
    const env = { ...process.env, GIT_AUTHOR_NAME: "nukadoko", GIT_AUTHOR_EMAIL: "nukadoko@example.invalid", GIT_COMMITTER_NAME: "nukadoko", GIT_COMMITTER_EMAIL: "nukadoko@example.invalid" };
    for (const argv of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "the project"]]) {
      const ran = await runCommand("git", argv, { cwd: dir, env });
      if (ran.exitCode !== 0) throw new Error(`git ${argv.join(" ")} exited ${ran.exitCode}: ${ran.stderr}`);
    }
    return { dir };
  },
});
