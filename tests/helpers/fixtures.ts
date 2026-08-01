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
