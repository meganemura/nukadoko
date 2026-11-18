// Responsibility: copy the files this package ships but does not own from the
// repository root into this directory, so `npm pack`, the tests, and a
// reader of node_modules see them where they always were. Boundary: replaces
// the listed paths here with fresh copies of the root's, and nothing else.
//
// The repository holds one engine per language (`typescript/`, `ruby/`) and
// keeps what both engines follow at its root: the spec and the skills.
// Each engine keeps its own changelog and its own README (the npm page is
// typescript/README.md, which says only what this engine adds). npm
// packs only what is inside the package's own directory, and it skips a
// symbolic link, so a link would leave the tarball without its docs. A copy
// made on every build is the shape that keeps one source at the root and
// the same tarball as before. The copies are gitignored; edit the root's
// files, never these.
//
// Run directly by Node (type stripping), so erasable syntax only.

import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SHARED = ["docs", "skills", "llms.txt", "LICENSE"];

const here = path.resolve(import.meta.dirname, "..");
const root = path.resolve(here, "..");

export function stageShared(): void {
  for (const name of SHARED) {
    const target = path.join(here, name);
    rmSync(target, { recursive: true, force: true });
    cpSync(path.join(root, name), target, { recursive: true });
  }
}

// `node scripts/stage-shared.ts` from the build; tests/global-setup.ts calls
// the function, so a test run that skips the build still reads fresh copies.
if (process.argv[1] === fileURLToPath(import.meta.url)) stageShared();
