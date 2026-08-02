import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
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
//
// Single `register({ namespace })` per discovery run, not per-file
// `tsImport()`: tsx's `tsImport()` convenience wrapper mints a fresh
// namespace/module registration on every call (confirmed by reading tsx's
// own source), so loading each step file with its own `tsImport()` call
// would put every file in its own isolated module graph. A step file's own
// relative import of another step file would then resolve to a *different*
// registration than this function's own direct load of that same file —
// two distinct Step objects that are never `===`. `ctx.resultOf`
// (docs/spec.md "Context API") keys its result chain on Step object
// identity, so that would silently break `ctx.resultOf` for any chain
// crossing a file boundary (tests/resultof.test.ts's empirical proof).
// Calling tsx's `register({ namespace })` exactly once per discovery run
// and reusing the scoped `.import()` it returns for every file instead
// puts every load on one shared module graph, so the same file always
// yields the same object however it's reached.

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

  // One namespace per discovery run (random, not a counter or timestamp:
  // this can run concurrently with other discovery runs, e.g. across test
  // files, and namespaces must not collide) — every file below is loaded
  // through this single registration's scoped `.import()`, and the
  // registration is torn down in `finally` so a thrown DuplicateStepError
  // or a broken step file's own throw never leaks it.
  const scoped = register({ namespace: randomUUID() });
  try {
    const vocabulary = new Map<string, VocabularyEntry>();
    for (const filePath of files) {
      const mod: { default?: unknown } = await scoped.import(
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
  } finally {
    await scoped.unregister();
  }
}
