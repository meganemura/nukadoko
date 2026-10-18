import type * as Playwright from "playwright";

// Responsibility: the one place this package loads `playwright` at run time,
// and the one error a project without it sees. Every other module imports
// Playwright with `import type`, which erases, so no `nuka` command puts the
// package on its load path until a step actually asks for `ctx.page()`,
// or `ctx.request()`.
//
// `playwright` is an optional peer dependency (package.json) because it and
// `playwright-core` were most of the install size, and a project that drives
// a CLI or an HTTP-free library never opens a browser. A static import here
// would make every command fail on such a project, including `nuka init`
// and `nuka check`, which never need it.

const SPECIFIER = "playwright";
// The version this package is built and tested against: the exact
// `devDependencies` pin in package.json, and the floor of the
// `peerDependencies` caret range. The install hint names this exact version
// because it is the one CI runs; the peer range is a caret so that a project
// already on a later Playwright 1.x installs without npm's ERESOLVE. A test
// reads package.json and compares, so the three cannot drift.
export const PLAYWRIGHT_VERSION = "1.61.1";

export type PlaywrightModule = typeof Playwright;

/** Thrown when a step needs Playwright and the project has not installed it.
 * The message is one line: what needed it, and the command that fixes it. */
export class PlaywrightMissingError extends Error {
  readonly neededBy: string;
  /** The next command a CLI refusal names (src/cli/refusal.ts). */
  readonly do = `npm install -D -E ${SPECIFIER}@${PLAYWRIGHT_VERSION}`;

  constructor(neededBy: string) {
    super(
      `${neededBy} needs "${SPECIFIER}", and this project has not installed it. ` +
        `Install the version nukadoko is tested against: npm install -D -E ${SPECIFIER}@${PLAYWRIGHT_VERSION}`,
    );
    this.name = "PlaywrightMissingError";
    this.neededBy = neededBy;
  }
}

/** The packages a step file may import Playwright through. Each publishes
 * the same version numbers, so the install line names the tested one. */
const PLAYWRIGHT_PACKAGES: ReadonlySet<string> = new Set([SPECIFIER, "playwright-core", "@playwright/test"]);

/**
 * The text and the next command for a step file that did not import because
 * Node could not find `missing`, a Playwright package the project has not
 * installed, or `undefined` when it is not a Playwright one. The step file
 * may import it itself or through `missing.importedBy`, another of the
 * project's files; either way installing it is the fix. Every command that
 * imports step files reports this case through here: Node's own message
 * ends in a "Did you mean" hint that points at the wrong fix.
 */
export function playwrightPackageMissing(
  missing: { readonly name: string; readonly importedBy?: string } | undefined,
): { readonly message: string; readonly do: string } | undefined {
  if (missing === undefined || !PLAYWRIGHT_PACKAGES.has(missing.name)) return undefined;
  const install = `npm install -D -E ${missing.name}@${PLAYWRIGHT_VERSION}`;
  const reaches =
    missing.importedBy === undefined
      ? `the step file imports "${missing.name}"`
      : `the step file imports "${missing.name}" through ${missing.importedBy}`;
  return {
    message: `${reaches}, and this project has not installed it, so the file does not import. Install the version nukadoko is tested against: ${install}`,
    do: install,
  };
}

/**
 * True only when `error` is Node's own `ERR_MODULE_NOT_FOUND` for the
 * `playwright` package itself. Checked this narrowly so that a missing
 * `playwright-core`, or any other broken import inside an installed
 * Playwright, keeps its own real message instead of an install hint that
 * would not fix it.
 */
export function isPlaywrightMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes(`'${SPECIFIER}'`)
  );
}

/**
 * Whether `loadPlaywright` would find the package, answered without loading
 * it. `import.meta.resolve` here resolves from this module, the same place
 * the `import()` below resolves from, so `nuka check` and a run agree on
 * whether a project has Playwright. Resolving reads `package.json` files
 * only; importing Playwright would cost the check most of its time.
 */
export function isPlaywrightInstalled(): boolean {
  try {
    import.meta.resolve(SPECIFIER);
    return true;
  } catch (error) {
    if (isPlaywrightMissing(error)) return false;
    throw error;
  }
}

/** Loads `playwright`, or throws `PlaywrightMissingError` naming `neededBy`
 * (a step's text, or the command or API that asked). */
export async function loadPlaywright(neededBy: string): Promise<PlaywrightModule> {
  try {
    return await import(SPECIFIER);
  } catch (error) {
    if (isPlaywrightMissing(error)) throw new PlaywrightMissingError(neededBy);
    throw error;
  }
}
