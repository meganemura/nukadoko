import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Responsibility: the one place tests compute absolute paths to
// tests/fixtures/* and the repo root, so individual test files don't each
// re-derive `import.meta.url` -> directory arithmetic.

const here = path.dirname(fileURLToPath(import.meta.url));

export const testsDir = path.resolve(here, "..");
export const repoRoot = path.resolve(testsDir, "..");
export const fixturesDir = path.join(testsDir, "fixtures");

export function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

// Deliberately *inside* the repo tree (under tests/, not the OS temp dir):
// a copied fixture's step files still get loaded via tsx's tsImport, which
// resolves bare specifiers like "zod" the normal Node way — walking up
// parent directories looking for node_modules. A copy under the system temp
// dir has no such ancestor and every import fails; nested under tests/ it
// walks straight up to the repo's own node_modules, same as the fixtures
// tree it was copied from.
const tempFixturesRoot = path.join(testsDir, ".tmp-fixtures");

/**
 * Copies a fixture project into a fresh temp directory. Tests that actually
 * execute a step (via `nuka do`) write real files under `.nukadoko/` as a
 * side effect; running against a throwaway copy instead of the committed
 * fixture keeps the repo's tracked fixtures clean and lets tests using the
 * same fixture run without colliding on shared state. Pair with
 * `removeTempDir` in a `finally`.
 */
export async function copyFixtureToTempDir(name: string): Promise<string> {
  await mkdir(tempFixturesRoot, { recursive: true });
  const dest = await mkdtemp(path.join(tempFixturesRoot, "fixture-"));
  await cp(fixture(name), dest, { recursive: true });
  return dest;
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** A minimal in-memory sink satisfying cli/run-cli.ts's WritableSink. */
export function createCaptureSink(): { write(chunk: string): boolean; text(): string } {
  let buffer = "";
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    text() {
      return buffer;
    },
  };
}
