import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cjsTsMismatchExplanation, isCommonJsProject } from "../config/module-kind.js";
import { register } from "tsx/esm/api";
import type { z } from "zod";
import type { DeclaredCollector } from "../compat/declared.js";
import type { HookRegistration } from "../compat/hooks.js";
import type {
  CompatKeyword,
  CompatParameterTypeRegistration,
  CompatStepFn,
} from "../compat/registry.js";
import type { RunHookRegistration } from "../compat/run-hooks.js";
import type { InstantiatedWorld } from "../compat/world.js";
import type { StepContext } from "../context.js";
import { isStep, type Step } from "../step/define-step.js";
import {
  DuplicateCompatStepError,
  DuplicateStepError,
  DuplicateWorldDefinitionError,
} from "./errors.js";

// Responsibility: walk `featuresDir`, import every `.ts`/`.mts`/`.js`/`.mjs`
// file found -- skipping `node_modules` at any depth, any dot-directory
// (`.git`, `.nukadoko`, ...), and `.d.ts`/`.d.mts` declarations; see
// `walkStepFiles`'s own comment for why -- and collect the vocabulary of
// typed steps by filename, plus every compat step and compat
// `defineParameterType` call any of those files made along the way.
// Deliberately imports modules
// to discover them (docs/spec.md "Implementation notes" accepts this:
// listing the vocabulary requires running each file's top-level code, same
// as executing it). A default export that isn't a branded Step (e.g. a
// shared helper under `steps/lib/`) is not an error — it's just not a step,
// and is skipped silently. Two files producing the same typed step name, or
// two `Given`/`When`/`Then` calls anywhere resolving to the same compat
// pattern source, are both errors: identity (a file name for typed, a
// pattern source for compat) must be unique, and a silent last-write-wins
// would hide a real collision.
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
 * called here — that happens in src/run/. */
export interface CompatStepDefinition {
  readonly keyword: CompatKeyword;
  readonly pattern: string | RegExp;
  readonly patternSource: string;
  readonly fn: CompatStepFn;
  /** From the registration's own `{ timeout }` — carried through so
   * src/run/run-scenario.ts can actually
   * enforce it; src/compat/registry.ts only records it (that file's own
   * `CompatStepRegistration.timeoutMs` comment). Previously dropped right
   * here, which is why a `{ timeout }` step never actually timed out despite
   * src/compat/registry.ts already keeping the value on `CompatStepRegistration`. */
  readonly timeoutMs?: number;
  readonly registrationOrder: number;
}

export interface CompatVocabularyEntry {
  readonly kind: "compat";
  /** `compat: <patternSource>` — a compat step has no file-derived name (one
   * file can register many), so identity comes from the pattern itself.
   * This is also this entry's key in `Vocabulary`. */
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
 * exist (config is the typed-era home for this). `filePath` is rootDir-relative, same as
 * `importFailures[].filePath` below — src/check/binding-check.ts puts this
 * straight into a `CheckIssue.file`, and every other `CheckIssue.file` this
 * run's caller (src/check/analyze.ts) produces is already relative
 * (src/feature/load-features.ts's `relativePath`, src/check/feature-
 * check.ts's `file`), so this was the one field that disagreed. */
export interface CompatParameterTypeEntry extends CompatParameterTypeRegistration {
  readonly filePath: string;
}

export interface DiscoveryResult {
  readonly vocabulary: Vocabulary;
  readonly compatParameterTypes: readonly CompatParameterTypeEntry[];
  /** Constructs one pickle's own World — base `World`, or whatever this
   * run's step files last passed to `setWorldConstructor` — with `ctx`
   * attached as the runtime bridge `World.openPage()`/`openRequest()` read
   * from, already wrapped for measurement + this run's own `defineWorld`
   * schemas, and its `attach`/`log`/`link` wired to the given
   * `declaredCollector` (src/run/run-scenario.ts passes its own per-pickle
   * collector here, directly, for the module-identity reason
   * src/compat/world.ts's own header explains). Bound
   * to the *exact* module instance this discovery run's own scoped tsx
   * import loaded src/compat/world.ts through (see that file's header for
   * why identity matters here) — callers (src/run/run-scenario.ts) never
   * import world.js directly themselves. */
  readonly instantiateCompatWorld: (
    ctx: StepContext,
    declaredCollector: DeclaredCollector,
  ) => InstantiatedWorld;
  /** Every Before/After hook any step file registered during this run — not
   * attributed to a file (see src/compat/hooks.ts's header), read once here
   * after every file's import has finished. */
  readonly compatHooks: readonly HookRegistration[];
  /** Every BeforeAll/AfterAll hook any step file registered during this run
   * — same "not attributed to a file, read once at the end" contract as
   * `compatHooks`, via src/compat/run-hooks.ts instead. src/cli/run.ts is
   * what actually runs these (unlike `compatHooks`, which
   * src/run/run-scenario.ts runs per
   * pickle) — a run-scope hook has no pickle to be scoped to. */
  readonly compatRunHooks: readonly RunHookRegistration[];
  /** `setDefaultTimeout`'s final value for this run, or `undefined` if it
   * was never called — read once here, after every file's import has
   * finished, same timing as
   * `compatHooks` (last call anywhere in this run wins; see
   * src/compat/registry.ts's own header for why "last wins" rather than
   * per-file attribution). `undefined` here must keep meaning "run
   * unbounded" downstream (src/run/run-scenario.ts, src/cli/run.ts) — never
   * defaulted to cucumber-js's own 5000ms (see `setDefaultTimeout`'s own
   * comment for why). */
  readonly defaultTimeoutMs: number | undefined;
  /** One entry per file whose `scoped.import()` threw, tolerant mode only —
   * always `[]` in the default (non-tolerant) mode, since that mode rejects
   * on the first such
   * file instead of collecting them. `filePath` is rootDir-relative, matching
   * every other `CheckIssue.file` this run's caller (src/check/analyze.ts)
   * already produces (src/feature/load-features.ts's `relativePath`,
   * src/check/feature-check.ts's `file`). `message` is the importing error's
   * own `.message`, unmodified — see the `catch` below for why. */
  readonly importFailures: readonly { filePath: string; message: string }[];
  /** rootDir-relative paths of every `.cjs` file this run's walk found
   * under `featuresDir` (skipping `node_modules` and any dot-directory, the
   * same walk every other file here goes through) and never attempted to
   * import: nukadoko is ESM-only (docs/migration.md's own go/no-go for
   * CommonJS glue), and `.cjs` always resolves to CommonJS regardless of
   * the nearest `package.json`'s own `"type"`, so importing one the way a
   * `.ts`/`.mts`/`.js`/`.mjs` file is imported below would just be a
   * different, more confusing way to fail. `nuka check`'s
   * `step-file-unsupported-extension`
   * reports each one by name instead of letting whatever it would have
   * defined resurface as an unexplained `undefined-step`. */
  readonly unsupportedExtensionFiles: readonly string[];
  /** rootDir-relative paths of every `.ts`/`.mts`/`.js`/`.mjs` file this
   * run's walk found and attempted to import -- including a file that ends
   * up in `importFailures`, and a file that imports cleanly but defines no
   * step or compat registration at all. `vocabulary` alone can't answer
   * "did the walk find anything to try": an empty vocabulary is also what a
   * project with real, cleanly-importing support-only files (no
   * `Given`/`When`/`Then`, no `export default defineStep(...)`) produces.
   * This list is what lets `nuka check`'s `no-step-files-found` tell those
   * two apart and name every directory it
   * walked -- the same "so a reader can tell a finding isn't lying"
   * reasoning as `nuka tend`'s own `scanned:` line (src/cli/tend.ts). */
  readonly walkedFiles: readonly string[];
}

function compatPatternSource(pattern: string | RegExp): string {
  return typeof pattern === "string" ? pattern : pattern.toString();
}

// `.d.ts`/`.d.mts` checked (and skipped) ahead of the plain extensions below
// since a declaration file's own name also ends in `.ts`/`.mts` -- checking
// order matters here, the plain-extension check must never see one first.
const DECLARATION_FILE_EXTENSIONS = [".d.ts", ".d.mts"];
// tsx's `tsImport` reads all four directly (docs/spec.md "Implementation
// notes"); `.cjs` is deliberately absent -- see `unsupportedExtensionFiles`
// on `DiscoveryResult` for why it is walked and named, but never imported.
const STEP_FILE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];
const UNSUPPORTED_STEP_FILE_EXTENSION = ".cjs";

interface WalkStepFilesResult {
  /** Absolute paths, sorted, of every candidate step file found. */
  readonly files: string[];
  /** Absolute paths, sorted, of every `.cjs` file found alongside them. */
  readonly unsupportedExtensionFiles: string[];
}

// Named `walkStepFiles`, not `walkTsFiles`: `.mts`/`.js`/`.mjs` join `.ts`
// as files this function walks, so a name naming only `.ts` would no
// longer match what it does.
//
// `node_modules` and any dot-directory (`.git`, `.nukadoko`, an editor's
// own `.vscode`, ...) are skipped at every depth, not just featuresDir's
// own immediate children -- this is independent of which extensions are
// walked, since a project with `featuresDir: "."` (a real, observed
// configuration) already walked
// `node_modules` recursively and imported every `.ts` file a dependency
// shipped, `.d.ts` included, before this function ever considered `.js`.
// `.d.ts`/`.d.mts` are excluded because a type declaration is never a step
// definition: it has no runtime statements to evaluate at all (a compiler
// error if it did), so importing one would only ever produce an empty
// module -- something to skip outright, not something worth spending an
// import call on.
function walkStepFiles(dir: string): WalkStepFilesResult {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // featuresDir (or a subdirectory) not existing is not this function's
    // problem to diagnose — an empty vocabulary is a valid, if unhelpful,
    // answer to "what steps exist".
    return { files: [], unsupportedExtensionFiles: [] };
  }

  const files: string[] = [];
  const unsupportedExtensionFiles: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const nested = walkStepFiles(fullPath);
      files.push(...nested.files);
      unsupportedExtensionFiles.push(...nested.unsupportedExtensionFiles);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (DECLARATION_FILE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      continue;
    }
    if (STEP_FILE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath);
      continue;
    }
    if (entry.name.endsWith(UNSUPPORTED_STEP_FILE_EXTENSION)) {
      unsupportedExtensionFiles.push(fullPath);
    }
  }
  return { files, unsupportedExtensionFiles };
}

export interface DiscoverStepsOptions {
  /** Default `false`: `discoverSteps` rejects on the first file whose import
   * fails — `run`/`do`/`steps`/`init` all stay fail-fast on purpose:
   * continuing past a broken glue file is dangerous for anything that's
   * about to *execute*. `true` is `nuka check`'s own mode (src/check/
   * analyze.ts): a broken file is collected into `importFailures` instead,
   * so the rest of the project can still be discovered and reported on — a
   * migrating suite's normal state is "some glue files are still broken",
   * and a report tool that refuses to run at all in that state isn't useful
   * as a migration dashboard. One discovery function, one behavior flag —
   * not a second copy of the loop — keeps this a single source of truth
   * (the migration-door rule: one mechanism, not a fork). */
  readonly tolerateImportFailures?: boolean;
}

export async function discoverSteps(
  rootDir: string,
  featuresDir: string,
  options: DiscoverStepsOptions = {},
): Promise<DiscoveryResult> {
  const { tolerateImportFailures = false } = options;
  const featuresRoot = path.join(rootDir, featuresDir);
  const { files, unsupportedExtensionFiles } = walkStepFiles(featuresRoot);

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
    // Same identity reasoning as compatRegistry above, extended to World and
    // Before/After: loaded through this run's own scoped import, never a
    // plain top-level
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
    // Same identity reasoning again, for BeforeAll/AfterAll: loaded through
    // this run's own scoped import so a step file's `BeforeAll`/`AfterAll`
    // call via "nukadoko/compat" lands in the exact instance drained below.
    const compatRunHooksModule = (await scoped.import(
      new URL("../compat/run-hooks.js", import.meta.url).href,
      import.meta.url,
    )) as typeof import("../compat/run-hooks.js");
    // Same identity reasoning again, for `defineWorld` —
    // src/compat/define-world.ts's own registration buffer, loaded through
    // this run's own scoped import so a step file's
    // `defineWorld(...)` call via "nukadoko/compat" lands in the exact
    // instance this function drains below.
    const defineWorldModule = (await scoped.import(
      new URL("../compat/define-world.js", import.meta.url).href,
      import.meta.url,
    )) as typeof import("../compat/define-world.js");

    const vocabulary = new Map<string, VocabularyEntry>();
    const compatParameterTypes: CompatParameterTypeEntry[] = [];
    // At most one file's worth of `defineWorld` schemas ever wins — a second
    // registration, anywhere, is always an error, detected here rather than
    // inside define-world.ts itself so both offending files can be named
    // (DuplicateWorldDefinitionError), the same reasoning
    // DuplicateCompatStepError already applies to a colliding compat step.
    let declaredWorldSchemas: Readonly<Record<string, z.ZodTypeAny>> = {};
    let declaredWorldSchemasFilePath: string | undefined;
    const importFailures: { filePath: string; message: string }[] = [];

    for (const filePath of files) {
      // Scope note: this only catches a file whose import itself throws. A
      // name imported but used only as a type annotation, or imported and
      // never referenced at all, is elided from the compiled output by
      // esbuild/tsx and so never actually gets imported at run time — that
      // file imports cleanly here even if the name it asked for doesn't
      // exist on the compat surface. That is not a detection gap this loop
      // is failing to close: a glue file esbuild elides the import from
      // runs exactly as written, so there is nothing broken to report.
      //
      // Only the import call itself is inside this try — `isStep`, the
      // drains below, and the duplicate checks they can throw all stay
      // outside it, so they only
      // ever run once this file's own import has actually succeeded. Putting
      // them inside the same try would let a DuplicateStepError/
      // DuplicateCompatStepError/DuplicateWorldDefinitionError — a cross-file
      // authoring mistake, not an import failure — get caught here and
      // misreported as this file's own import failing.
      let mod: { default?: unknown };
      try {
        mod = await scoped.import(pathToFileURL(filePath).href, import.meta.url);
      } catch (error) {
        if (!tolerateImportFailures) {
          // The tolerant path (nuka check, nuka tend) reports this failure
          // through `importFailures`, where the same explanation is added on
          // the way out. This path throws instead, so the explanation has to
          // travel with the error: `nuka run` and `nuka do` are the commands
          // most likely to be typed first, and Node's own message for this
          // case names a path the file plainly occupies, which reads as a
          // missing file rather than a module kind the project decides.
          const explanation = cjsTsMismatchExplanation(isCommonJsProject(rootDir), filePath);
          if (explanation === "" || !(error instanceof Error)) {
            throw error;
          }
          throw new Error(`${error.message}${explanation}`, { cause: error });
        }
        // A file that dies partway through its own evaluation (CommonJS
        // `require()` inside an ESM file throws mid-evaluation, not at ESM's
        // earlier link phase) may already have called
        // `Given`/`Before`/`defineWorld` before it threw, leaving those
        // calls sitting in the shared buffers below. Draining and
        // discarding them here, rather than leaving them for the *next*
        // file's own drain, is what keeps this loop's per-file attribution
        // (the comment above) from misattributing a dead file's partial
        // registrations to whichever healthy file happens to import next.
        compatRegistry.drainCompatSteps();
        compatRegistry.drainCompatParameterTypes();
        defineWorldModule.drainWorldSchemaRegistrations();
        importFailures.push({
          filePath: path.relative(rootDir, filePath),
          // Passed through verbatim, not re-classified into a nukadoko code:
          // Node's own message already names the missing
          // export/subpath/package, and reparsing it here would only add a
          // brittle dependency on Node's exact wording while
          // losing information.
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const candidate = mod.default;
      if (isStep(candidate)) {
        // `path.extname` rather than a hardcoded `".ts"`: `walkStepFiles`
        // hands this loop a mix of
        // `.ts`/`.mts`/`.js`/`.mjs` files, and each one's own extension is
        // exactly what should come off its name, whichever one it is.
        const name = path.basename(filePath, path.extname(filePath));
        const existing = vocabulary.get(name);
        if (existing) {
          throw new DuplicateStepError(name, existing.filePath, filePath);
        }
        vocabulary.set(name, { kind: "typed", name, filePath, step: candidate });
      }

      // Attribute this file's own compat registrations: drained immediately
      // after this file's own import completes, before the next file's
      // import can add anything
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
        // Relative, not the loop's own absolute `filePath` — see this
        // interface's own comment above for why it must match
        // `importFailures[].filePath`.
        compatParameterTypes.push({ ...registration, filePath: path.relative(rootDir, filePath) });
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
      // header, on concurrent-discovery safety): a World constructor/hook isn't
      // attributed to any one file, unlike a compat step, so there is
      // nothing to drain per file — just this run's own final state.
      // `declaredWorldSchemas` is curried in here so
      // `instantiateWorldForPickle` never needs to reach
      // back into src/compat/define-world.ts's own buffer itself.
      instantiateCompatWorld: (ctx: StepContext, declaredCollector: DeclaredCollector) =>
        compatWorld.instantiateWorldForPickle(ctx, declaredWorldSchemas, declaredCollector),
      compatHooks: compatHooksModule.getRegisteredHooks(),
      compatRunHooks: compatRunHooksModule.getRegisteredRunHooks(),
      // Read through `compatRegistry` — already loaded above for the step
      // buffer, and `setDefaultTimeout`'s own buffer lives in that same
      // module (see registry.ts's own header for why).
      defaultTimeoutMs: compatRegistry.getDefaultTimeoutMs(),
      importFailures,
      unsupportedExtensionFiles: unsupportedExtensionFiles.map((filePath) =>
        path.relative(rootDir, filePath),
      ),
      walkedFiles: files.map((filePath) => path.relative(rootDir, filePath)),
    };
  } finally {
    await scoped.unregister();
  }
}
