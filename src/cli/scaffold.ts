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
// The `returns` comment deliberately does not frame the field as "what
// later steps cite" alone (docs/spec.md "Typed steps"): that framing is
// what a first reader adopts, and it drops every value the step's own
// correctness depends on but nothing downstream reads — which is exactly
// the set a receipt gets interrogated for once a run has gone wrong: a
// step that sends a date nothing cites, computed in the wrong timezone,
// leaves a receipt that cannot say which date it sent, and the answer has
// to be reconstructed from someone else's error message instead.
//
// The absence line right beneath it is the same idea, sharpened by an
// incident: `visible: false` and `count: 0` erase the difference between
// "genuinely not there" and "not rendered yet" unless the step returns
// proof of which one it saw (docs/spec.md "Typed steps").
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
    "  // Give every field a .describe(): `nuka describe` surfaces it, and that is",
    "  // what lets an acceptance criterion's own wording be matched to the field",
    "  // that answers it.",
    "  args: z.object({",
    '    // name: z.string().describe("what this value is, in the words a criterion uses"),',
    "  }),",
    "  returns: z.object({",
    "    // Not only what later steps cite: also the values this step's own",
    "    // correctness rests on (the date it computed, the id it picked)",
    "    // because a receipt can only be read for what it was given.",
    "    // If a result can be an absence (false, 0, an empty string), return",
    "    // proof the read was valid too, not the absence on its own.",
    '    // id: z.string().describe("what this step produced, and what a failure here would be diagnosed from"),',
    "  }),",
    "  // Why this step is built this way, and what was tried and rejected:",
    "  // not what it does (`description` above already says that), but why",
    "  // it looks like this. `nuka tend` flags a step with none",
    "  // (`step-rationale-missing`), because that is the material a later",
    "  // reader needs before deciding whether this step may be rewritten.",
    '  // rationale: "why this shape, what was rejected",',
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
