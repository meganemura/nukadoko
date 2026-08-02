import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import type { z } from "zod";
import type { DeclaredCollector } from "../compat/declared.js";
import type { HookRegistration } from "../compat/hooks.js";
import type {
  CompatKeyword,
  CompatParameterTypeRegistration,
  CompatStepFn,
} from "../compat/registry.js";
import type { InstantiatedWorld } from "../compat/world.js";
import type { StepContext } from "../context.js";
import { isStep, type Step } from "../step/define-step.js";
import {
  DuplicateCompatStepError,
  DuplicateStepError,
  DuplicateWorldDefinitionError,
} from "./errors.js";

// Responsibility: walk `featuresDir`, import every `.ts` file found, and
// collect the vocabulary of typed steps by filename, plus (m2a-compat-
// registry task spec) every compat step and compat `defineParameterType`
// call any of those files made along the way. Deliberately imports modules
// to discover them (docs/spec.md "Implementation notes" accepts this:
// listing the vocabulary requires running each file's top-level code, same
// as executing it). A default export that isn't a branded Step (e.g. a
// shared helper under `steps/lib/`) is not an error — it's just not a step,
// and is skipped silently. Two files producing the same typed step name, or
// two `Given`/`When`/`Then` calls anywhere resolving to the same compat
// pattern source, are both errors: identity (a file name for typed, a
// pattern source for compat — m2a-compat-registry task spec, decision 3)
// must be unique, and a silent last-write-wins would hide a real collision.
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
//
// This same one-namespace-per-run property is what makes compat's
// registration buffer (src/compat/registry.ts) safe to read here: this
// function loads that module through the *same* scoped `.import()` used for
// every step file (never a plain top-level `import`), so this run's own
// instance of the buffer is the one, and only one, this run's own step
// files reach too — via "nukadoko/compat" -> ./index.js -> ./registry.js,
// resolving to the identical absolute file this function loads directly.
// A concurrent discovery run gets its own namespace and therefore its own,
// independent instance (tests/compat-discover.test.ts's concurrent test).

export interface TypedVocabularyEntry {
  readonly kind: "typed";
  readonly name: string;
  readonly filePath: string;
  readonly step: Step;
}

/** One `Given`/`When`/`Then` registration, as discovery attributes it to the
 * file that made the call. `pattern` is kept in its original form (a string
 * builds a plain cucumber-expression with no named-capture requirement — the
 * migration door's promise — a RegExp is matched as-is); `patternSource` is
 * the display/identity text derived from it. Execution (`fn`) is stored, not
 * called — M2's slice B. */
export interface CompatStepDefinition {
  readonly keyword: CompatKeyword;
  readonly pattern: string | RegExp;
  readonly patternSource: string;
  readonly fn: CompatStepFn;
  /** From the registration's own `{ timeout }` (m21b-compat-execution task
   * spec, item 2) — carried through so src/run/run-scenario.ts can actually
   * enforce it; src/compat/registry.ts only records it (that file's own
   * `CompatStepRegistration.timeoutMs` comment). Previously dropped right
   * here, which is why a `{ timeout }` step never actually timed out despite
   * A already keeping the value on `CompatStepRegistration`. */
  readonly timeoutMs?: number;
  readonly registrationOrder: number;
}

export interface CompatVocabularyEntry {
  readonly kind: "compat";
  /** `compat: <patternSource>` — a compat step has no file-derived name (one
   * file can register many), so identity comes from the pattern itself
   * (m2-design.md section 2). This is also this entry's key in `Vocabulary`. */
  readonly name: string;
  readonly filePath: string;
  readonly compat: CompatStepDefinition;
}

/** Deliberately a union, not a looser shape: existing typed-only readers
 * (src/run/match-step.ts, src/run/run-scenario.ts) must narrow on `kind`
 * before touching `.step`, so a caller that isn't ready for compat entries
 * fails to compile instead of crashing on a missing field at run time. */
export type VocabularyEntry = TypedVocabularyEntry | CompatVocabularyEntry;

export type Vocabulary = ReadonlyMap<string, VocabularyEntry>;

/** A `defineParameterType` call made from compat ("support") code, plus the
 * file it came from. src/check/binding-check.ts merges these into the same
 * `ParameterTypeRegistry` as `config.parameterTypes` and warns that they
 * exist (parameter-types-design.md's "gradual compat" section: "config が
 * typed 時代の家"). */
export interface CompatParameterTypeEntry extends CompatParameterTypeRegistration {
  readonly filePath: string;
}

export interface DiscoveryResult {
  readonly vocabulary: Vocabulary;
  readonly compatParameterTypes: readonly CompatParameterTypeEntry[];
  /** Constructs one pickle's own World — base `World`, or whatever this
   * run's step files last passed to `setWorldConstructor` (m2b-compat-
   * execution task spec, item 1) — with `ctx` attached as the runtime bridge
   * `World.openPage()`/`openRequest()` read from, already wrapped for
   * measurement + this run's own `defineWorld` schemas (m2c-typed-world task
   * spec, items 1-2), and its `attach`/`log`/`link` wired to the given
   * `declaredCollector` (m2d-allure-shim task spec, item 4 — src/run/run-
   * scenario.ts passes its own per-pickle collector here, directly, for the
   * module-identity reason src/compat/world.ts's own header explains). Bound
   * to the *exact* module instance this discovery run's own scoped tsx
   * import loaded src/compat/world.ts through (see that file's header for
   * why identity matters here) — callers (src/run/run-scenario.ts) never
   * import world.js directly themselves. */
  readonly instantiateCompatWorld: (
    ctx: StepContext,
    declaredCollector: DeclaredCollector,
  ) => InstantiatedWorld;
  /** Every Before/After hook any step file registered during this run
   * (m2b-compat-execution task spec, item 5) — not attributed to a file
   * (see src/compat/hooks.ts's header), read once here after every file's
   * import has finished. */
  readonly compatHooks: readonly HookRegistration[];
}

function compatPatternSource(pattern: string | RegExp): string {
  return typeof pattern === "string" ? pattern : pattern.toString();
}

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
): Promise<DiscoveryResult> {
  const featuresRoot = path.join(rootDir, featuresDir);
  const files = walkTsFiles(featuresRoot);

  // One namespace per discovery run (random, not a counter or timestamp:
  // this can run concurrently with other discovery runs, e.g. across test
  // files, and namespaces must not collide) — every file below is loaded
  // through this single registration's scoped `.import()`, and the
  // registration is torn down in `finally` so a thrown DuplicateStepError/
  // DuplicateCompatStepError or a broken step file's own throw never leaks
  // it.
  const scoped = register({ namespace: randomUUID() });
  try {
    // Loaded through `scoped` itself (not a plain top-level `import`) so
    // this run's own compat registration buffer is the one, and only the
    // one, tsx's namespace isolation gives it (see this file's own header,
    // and src/compat/registry.ts's) — a plain top-level import would
    // instead share one instance across every discovery run in this
    // process, defeating the isolation tests/compat-discover.test.ts's
    // concurrent test depends on.
    const compatRegistry = (await scoped.import(
      new URL("../compat/registry.js", import.meta.url).href,
      import.meta.url,
    )) as typeof import("../compat/registry.js");
    // Same identity reasoning as compatRegistry above, extended to World
    // (m2b-compat-execution task spec, item 1) and Before/After (item 5):
    // loaded through this run's own scoped import, never a plain top-level
    // one, so `setWorldConstructor`/`Before`/`After` calls a step file makes
    // via "nukadoko/compat" land in the exact instances captured here.
    const compatWorld = (await scoped.import(
      new URL("../compat/world.js", import.meta.url).href,
      import.meta.url,
    )) as typeof import("../compat/world.js");
    const compatHooksModule = (await scoped.import(
      new URL("../compat/hooks.js", import.meta.url).href,
      import.meta.url,
    )) as typeof import("../compat/hooks.js");
    // Same identity reasoning again, for `defineWorld` (m2c-typed-world task
    // spec, item 2) — src/compat/define-world.ts's own registration buffer,
    // loaded through this run's own scoped import so a step file's
    // `defineWorld(...)` call via "nukadoko/compat" lands in the exact
    // instance this function drains below.
    const defineWorldModule = (await scoped.import(
      new URL("../compat/define-world.js", import.meta.url).href,
      import.meta.url,
    )) as typeof import("../compat/define-world.js");

    const vocabulary = new Map<string, VocabularyEntry>();
    const compatParameterTypes: CompatParameterTypeEntry[] = [];
    // At most one file's worth of `defineWorld` schemas ever wins — a second
    // registration, anywhere, is always an error (m2c-typed-world task spec,
    // item 2: "2 回目はエラー"), detected here rather than inside define-
    // world.ts itself so both offending files can be named
    // (DuplicateWorldDefinitionError), the same reasoning
    // DuplicateCompatStepError already applies to a colliding compat step.
    let declaredWorldSchemas: Readonly<Record<string, z.ZodTypeAny>> = {};
    let declaredWorldSchemasFilePath: string | undefined;

    for (const filePath of files) {
      const mod: { default?: unknown } = await scoped.import(
        pathToFileURL(filePath).href,
        import.meta.url,
      );

      const candidate = mod.default;
      if (isStep(candidate)) {
        const name = path.basename(filePath, ".ts");
        const existing = vocabulary.get(name);
        if (existing) {
          throw new DuplicateStepError(name, existing.filePath, filePath);
        }
        vocabulary.set(name, { kind: "typed", name, filePath, step: candidate });
      }

      // Attribute this file's own compat registrations (m2a-compat-registry
      // task spec, decision 3): drained immediately after this file's own
      // import completes, before the next file's import can add anything
      // else, so whatever is in the buffer right here is exactly — and
      // only — this file's own contribution.
      for (const registration of compatRegistry.drainCompatSteps()) {
        const patternSource = compatPatternSource(registration.pattern);
        const compatName = `compat: ${patternSource}`;
        const existingCompat = vocabulary.get(compatName);
        if (existingCompat) {
          throw new DuplicateCompatStepError(patternSource, existingCompat.filePath, filePath);
        }
        vocabulary.set(compatName, {
          kind: "compat",
          name: compatName,
          filePath,
          compat: {
            keyword: registration.keyword,
            pattern: registration.pattern,
            patternSource,
            fn: registration.fn,
            timeoutMs: registration.timeoutMs,
            registrationOrder: registration.registrationOrder,
          },
        });
      }

      for (const registration of compatRegistry.drainCompatParameterTypes()) {
        compatParameterTypes.push({ ...registration, filePath });
      }

      // Same per-file attribution timing as compat steps above: drained
      // right after this file's own import, before the next file's import
      // can add anything else.
      for (const registration of defineWorldModule.drainWorldSchemaRegistrations()) {
        if (declaredWorldSchemasFilePath !== undefined) {
          throw new DuplicateWorldDefinitionError(declaredWorldSchemasFilePath, filePath);
        }
        declaredWorldSchemas = registration.schemas;
        declaredWorldSchemasFilePath = filePath;
      }
    }

    return {
      vocabulary,
      compatParameterTypes,
      // Read once, after every file's import has finished (this file's own
      // header, "並行 discovery の安全性"): a World constructor/hook isn't
      // attributed to any one file, unlike a compat step, so there is
      // nothing to drain per file — just this run's own final state.
      // `declaredWorldSchemas` is curried in here (m2c-typed-world task
      // spec, item 1) so `instantiateWorldForPickle` never needs to reach
      // back into src/compat/define-world.ts's own buffer itself.
      instantiateCompatWorld: (ctx: StepContext, declaredCollector: DeclaredCollector) =>
        compatWorld.instantiateWorldForPickle(ctx, declaredWorldSchemas, declaredCollector),
      compatHooks: compatHooksModule.getRegisteredHooks(),
    };
  } finally {
    await scoped.unregister();
  }
}
