import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { isStep, type Step } from "../step/define-step.js";
import { DuplicateStepError } from "./errors.js";

// Responsibility: walk `featuresDir`, import every `.ts` file found, and
// collect the vocabulary of typed steps by filename. Deliberately imports
// modules to discover them (docs/spec.md "Implementation notes" accepts
// this: listing the vocabulary requires running each file's top-level
// code, same as executing it). A default export that isn't a branded Step
// (e.g. a shared helper under `steps/lib/`) is not an error — it's just not
// a step, and is skipped silently. Two files producing the same step name
// is an error: step identity is the filename, and a silent last-write-wins
// would hide a real naming collision.

export interface VocabularyEntry {
  readonly name: string;
  readonly filePath: string;
  readonly step: Step;
}

export type Vocabulary = ReadonlyMap<string, VocabularyEntry>;

function walkTsFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // featuresDir (or a subdirectory) not existing is not this function's
    // problem to diagnose — an empty vocabulary is a valid, if unhelpful,
    // answer to "what steps exist".
    return [];
  }

  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function discoverSteps(
  rootDir: string,
  featuresDir: string,
): Promise<Vocabulary> {
  const featuresRoot = path.join(rootDir, featuresDir);
  const files = walkTsFiles(featuresRoot);

  const vocabulary = new Map<string, VocabularyEntry>();
  for (const filePath of files) {
    const mod: { default?: unknown } = await tsImport(
      pathToFileURL(filePath).href,
      import.meta.url,
    );
    const candidate = mod.default;
    if (!isStep(candidate)) {
      continue;
    }

    const name = path.basename(filePath, ".ts");
    const existing = vocabulary.get(name);
    if (existing) {
      throw new DuplicateStepError(name, existing.filePath, filePath);
    }
    vocabulary.set(name, { name, filePath, step: candidate });
  }
  return vocabulary;
}
