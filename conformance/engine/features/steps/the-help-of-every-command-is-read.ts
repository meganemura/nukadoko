import { defineStep, z } from "nukadoko";
import { nuka } from "./lib/engine.ts";
import theProject from "./the-project.ts";

// The flags a --help text names, as docs/engines.json writes them: --help and
// --version left out, and the TypeScript engine's negatable --check named by
// the negation a user types, --no-check, as the Ruby engine names it.
function flagsOf(help: string): string[] {
  const flags = [...help.matchAll(/^\s+(?:-[a-z], )?(--[a-z][a-z-]*)/gm)].map((m) => (m[1] === "--check" ? "--no-check" : m[1]!));
  return [...new Set(flags)].filter((flag) => flag !== "--help" && flag !== "--version").sort();
}

export default defineStep({
  description: "Read nuka --help for the commands this world's engine has, then each command's --help for its flags",
  pattern: "the help of every command is read",
  args: z.object({ dir: theProject.returns.shape.dir }),
  from: { dir: [theProject, "dir"] },
  returns: z.object({
    listed: z.string().describe("One line per command, sorted: the command, then the flags its --help names, sorted and separated by spaces"),
  }),
  // Help reads nothing and writes nothing.
  mutates: false,
  async run({}, { dir }) {
    const top = await nuka(dir, ["--help"]);
    const commands = [...top.stdout.matchAll(/^ {2}nuka ([a-z]+)/gm)].map((m) => m[1]!).sort();
    const lines: string[] = [];
    for (const command of commands) {
      const help = await nuka(dir, [command, "--help"]);
      if (help.exitCode !== 0) throw new Error(`nuka ${command} --help exited with ${help.exitCode}: ${help.stderr}`);
      lines.push([command, ...flagsOf(help.stdout)].join(" "));
    }
    return { listed: lines.join("\n") };
  },
});
