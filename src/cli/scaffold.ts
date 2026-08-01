import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka scaffold <name>`'s actual work (this task's spec,
// decision 2), kept out of run-cli.ts so it's unit-testable without going
// through yargs (same split as cli/do.ts and cli/init.ts). Unlike `init`,
// this command assumes a project already exists: it needs `featuresDir` from
// a successfully loaded config (this task's spec, decision 3), so a load
// failure here is reported exactly like any other command that loads config
// (cli/vocabulary.ts's `formatVocabularyError`), not a scaffold-specific
// error.
//
// `name` becomes the generated file's name, so it is restricted to
// `[a-z0-9-]+` (kebab-case — the existing "1 step = 1 file, file name is the
// step name" convention from docs/spec.md "Typed steps"), checked before
// anything else so an invalid name never reaches the filesystem. An
// existing file at the target path is refused rather than overwritten: a
// step that already has a real implementation must never be silently
// replaced by this template.
//
// The template omits `pattern`/`patterns` on purpose (this task's spec,
// decision 2): no pattern means CLI-only vocabulary by default (docs/
// spec.md "Typed steps") — a human adds a pattern by hand when the step is
// ready to be bound into a feature file. `run` always throws
// `not implemented: <name>`, so the step is discoverable (`nuka steps`) the
// moment it's scaffolded but fails every `nuka do`/`nuka run` call until a
// human replaces the body — "fails until implemented" (docs/spec.md
// "CLI summary"), enforced by the template itself rather than by a
// separate check.

export interface RunScaffoldOptions {
  rootDir: string;
  name: string;
  stdout: WritableSink;
  stderr: WritableSink;
}

const VALID_STEP_NAME = /^[a-z0-9-]+$/;

function stepTemplate(name: string): string {
  return [
    'import { defineStep } from "nukadoko";',
    'import { z } from "zod";',
    "",
    "export default defineStep({",
    `  description: "TODO: describe ${name}",`,
    "  args: z.object({}),",
    "  returns: z.object({}),",
    "  run() {",
    `    throw new Error("not implemented: ${name}");`,
    "  },",
    "});",
    "",
  ].join("\n");
}

export async function runScaffold(options: RunScaffoldOptions): Promise<number> {
  const { rootDir, name, stdout, stderr } = options;

  if (!VALID_STEP_NAME.test(name)) {
    stderr.write(
      `Invalid step name "${name}": must match [a-z0-9-]+ (kebab-case; it becomes the step's file name)\n`,
    );
    return 1;
  }

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  const relativeFilePath = path.join(config.featuresDir, "steps", `${name}.ts`);
  const filePath = path.join(rootDir, relativeFilePath);

  if (existsSync(filePath)) {
    stderr.write(`Refusing to scaffold: ${relativeFilePath} already exists\n`);
    return 1;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stepTemplate(name));

  stdout.write(`${relativeFilePath}\n`);
  return 0;
}
