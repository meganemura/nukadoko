// Builds a project from projects/<name> for the engine this world targets,
// and runs that engine's `nuka` in it. The engine is the world's
// NUKA_ENGINE: "typescript" or "ruby".
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "nukadoko";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, "../../..");
const root = path.resolve(engineRoot, "../..");

export function engine(): "typescript" | "ruby" {
  const name = process.env.NUKA_ENGINE;
  if (name !== "typescript" && name !== "ruby") throw new Error(`NUKA_ENGINE is ${JSON.stringify(name)}, not typescript or ruby`);
  return name;
}

// Copies the project's features and the steps written for this engine into dir.
export function buildProject(name: string, dir: string): void {
  const source = path.join(engineRoot, "projects", name);
  if (!existsSync(source)) throw new Error(`no project ${name} under conformance/engine/projects`);
  cpSync(path.join(source, "features"), path.join(dir, "features"), { recursive: true });
  const lang = engine() === "typescript" ? "ts" : "rb";
  cpSync(path.join(source, `steps-${lang}`), path.join(dir, "features", "steps"), { recursive: true });
  const files = path.join(source, "files");
  if (existsSync(files)) cpSync(files, dir, { recursive: true });
  const program = path.join(source, "program.json");
  if (engine() === "typescript") {
    writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
    mkdirSync(path.join(dir, "node_modules"));
    symlinkSync(path.join(root, "typescript"), path.join(dir, "node_modules", "nukadoko"), "dir");
    writeFileSync(path.join(dir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\n\nexport default defineConfig({});\n');
    if (existsSync(program)) {
      writeFileSync(path.join(dir, "nukadoko.program.ts"), `import { defineProgram } from "nukadoko";\n\nexport default defineProgram(${readFileSync(program, "utf8")});\n`);
    }
  } else if (existsSync(program)) {
    // JSON is a Ruby hash literal once its keys are symbols, so the program file is the JSON itself.
    writeFileSync(path.join(dir, "nukadoko.program.rb"), `require "json"\nNukadoko.program(**JSON.parse(${JSON.stringify(readFileSync(program, "utf8"))}, symbolize_names: true))\n`);
  }
}

export type Ran = { exitCode: number | null; stdout: string; stderr: string };

// The engine's own CLI, as a user of that engine runs it.
export async function nuka(dir: string, argv: string[]): Promise<Ran> {
  if (engine() === "typescript") {
    return await runCommand(process.execPath, [path.join(root, "typescript", "dist", "cli.js"), ...argv], { cwd: dir });
  }
  return await runCommand("bundle", ["exec", "ruby", path.join(root, "ruby", "exe", "nuka"), ...argv], {
    cwd: dir,
    env: { ...process.env, BUNDLE_GEMFILE: path.join(root, "ruby", "Gemfile") },
  });
}

// A step file the scenario names by its step name as `features/steps/<name>.*`:
// the TypeScript engine names the file after the step, and the Ruby engine
// after its snake_case form.
export function stepFile(file: string): string {
  const named = /^features\/steps\/([a-z0-9-]+)\.\*$/.exec(file);
  if (named === null) return file;
  return engine() === "typescript" ? `features/steps/${named[1]}.ts` : `features/steps/${named[1]!.replaceAll("-", "_")}.rb`;
}

// The text nuka printed with each step file written as `features/steps/<name>.*`,
// so both engines' output reads the same.
export function sameStepFiles(text: string): string {
  return text.replace(/features\/steps\/([a-z0-9_-]+)\.(ts|rb)\b/g, (_whole, name: string) => `features/steps/${name.replaceAll("_", "-")}.*`);
}
