// Responsibility: initialize the web-tree-sitter WASM engine exactly once
// and hand back the TypeScript/TSX Language objects, memoized so every
// caller in this package shares one Parser.init() call and one Language.load
// per grammar rather than repeating the (slow) WASM instantiation on every
// file. Running tree-sitter itself is the extension's own dependency
// executing, never the open workspace's code (the boundary the extension's
// design draws): this module never reads or evaluates anything from the
// workspace. src/extraction/step-extraction.ts is the only caller, and it
// hands this module source text it already read with fs.readFile.
import { existsSync } from "node:fs";
import path from "node:path";
import type * as WebTreeSitter from "web-tree-sitter";

// Loaded via a literal `require(...)`, not an `import` declaration, on
// purpose: web-tree-sitter ships two builds behind its package.json
// "exports" map, an ESM one (computes its own default asset path from
// `import.meta.url`) and a CommonJS one (uses `__dirname`/`__filename`
// instead, the same globals this file's own wasm-path resolution already
// depends on). esbuild picks the export condition the *source syntax* asks
// for, regardless of the bundle's own output format -- confirmed
// empirically: an `import` here pulls in the ESM build even under
// `--bundle --format=cjs`, and esbuild's CJS output replaces every
// `import.meta` with an empty object rather than a real URL, so the ESM
// build's own `createRequire(import.meta.url)` call throws the moment
// `Parser.init()` runs. A literal `require()` call makes esbuild resolve
// the "require" condition instead, bundling the CommonJS build, which
// never touches `import.meta` at all. `Parser` is re-exported from here
// rather than imported a second time by src/extraction/step-extraction.ts,
// so the whole package is only ever bundled once, through this one path.
const webTreeSitter = require("web-tree-sitter") as typeof WebTreeSitter;
export const Parser = webTreeSitter.Parser;
const { Language } = webTreeSitter;
type Language = WebTreeSitter.Language;

// `__dirname` resolves to two different places depending on how this module
// is loaded, and both have to work: bundled (`npm run build`'s esbuild step
// produces dist/extension.js as a single CommonJS file for the node
// platform, and esbuild keeps `__dirname` pointing at that bundle's own
// directory, dist/ -- confirmed empirically, not merely asserted), and
// unbundled (vitest runs this file straight from src/extraction/, two
// directories above dist/, and vite-node's own CommonJS-shape `__dirname`
// shim points there instead -- also confirmed empirically). Trying the
// bundled-shape candidate first, then the source-shape candidate, and
// picking whichever file actually exists, is what makes one code path
// correct in both places without a build-vs-test branch.
function wasmCandidatePaths(fileName: string): string[] {
  return [
    path.join(__dirname, "wasm", fileName),
    path.join(__dirname, "..", "..", "dist", "wasm", fileName),
  ];
}

function resolveWasmPath(fileName: string): string {
  const candidates = wasmCandidatePaths(fileName);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `tree-sitter-runtime: could not find "${fileName}". Tried:\n` +
      candidates.map((candidate) => `  - ${candidate}`).join("\n") +
      `\nRun "npm run build" (vscode/scripts/copy-wasm-assets.mjs copies it into dist/wasm/) first.`,
  );
}

let initPromise: Promise<void> | undefined;

// Emscripten's own `locateFile(fileName, prefix)` asks, for every side file
// the WASM runtime needs (its own `web-tree-sitter.wasm` engine), where to
// find it; redirecting through `resolveWasmPath` regardless of which name
// it asks for keeps this one function the single place that knows the
// bundled-vs-source layout difference explained above.
async function ensureInitialized(): Promise<void> {
  initPromise ??= Parser.init({
    locateFile: (fileName: string) => resolveWasmPath(fileName),
  });
  await initPromise;
}

let typescriptLanguagePromise: Promise<Language> | undefined;
let tsxLanguagePromise: Promise<Language> | undefined;

/** The TypeScript (`.ts`/`.mts`) grammar, loaded once and reused for every
 * file this package parses. */
export async function getTypeScriptLanguage(): Promise<Language> {
  await ensureInitialized();
  typescriptLanguagePromise ??= Language.load(resolveWasmPath("tree-sitter-typescript.wasm"));
  return typescriptLanguagePromise;
}

/** The TSX (`.tsx`) grammar -- a separate wasm from plain TypeScript
 * (tree-sitter-typescript ships the two as distinct grammars, since JSX
 * syntax changes how `<` is parsed). Loaded once and reused, same as
 * {@link getTypeScriptLanguage}. */
export async function getTsxLanguage(): Promise<Language> {
  await ensureInitialized();
  tsxLanguagePromise ??= Language.load(resolveWasmPath("tree-sitter-tsx.wasm"));
  return tsxLanguagePromise;
}
