#!/usr/bin/env node
// Responsibility: put the .wasm files a future phase's tree-sitter parsing
// needs where the bundled extension can find them at runtime.
//
// esbuild bundles JavaScript; it does not bundle a WebAssembly binary into
// that output. web-tree-sitter's own engine and the TypeScript/TSX grammars
// each ship as a separate .wasm file in their npm package, so this script
// copies them next to the bundled `dist/extension.js` instead. Nothing in
// `src/extension.ts` loads them yet (that is a later phase's work), but the
// copy step is wired in now so the later phase only has to add the load
// call, not also figure out where the files went.
//
// Node standard library only: this script runs as part of `npm run build`,
// before any dependency the extension bundles is guaranteed usable, so it
// keeps to `node:fs`/`node:path`, which need no install step of their own.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vscodeRoot = path.resolve(here, "..");
const wasmOutDir = path.join(vscodeRoot, "dist", "wasm");

// Each entry's source is a file a dependency ships today, at the pinned
// version in package.json; a version bump that renames the file should
// fail this script loudly rather than silently ship a stale or missing
// asset.
const assets = [
  path.join(vscodeRoot, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm"),
  path.join(vscodeRoot, "node_modules", "tree-sitter-typescript", "tree-sitter-typescript.wasm"),
  path.join(vscodeRoot, "node_modules", "tree-sitter-typescript", "tree-sitter-tsx.wasm"),
];

async function main() {
  await mkdir(wasmOutDir, { recursive: true });
  for (const source of assets) {
    const destination = path.join(wasmOutDir, path.basename(source));
    await copyFile(source, destination);
    console.log(`copy-wasm-assets: ${path.relative(vscodeRoot, source)} -> ${path.relative(vscodeRoot, destination)}`);
  }
}

await main();
