import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

/**
 * Copies a reader-facing project under `examples/<name>/` into a fresh temp
 * directory, the same way `copyFixtureToTempDir` does for `tests/fixtures/*`
 * — nested under `tempFixturesRoot` so `"nukadoko"` and `"zod"` still resolve
 * (see that function's own comment) and so running `nuka run`/`nuka do`
 * against it (examples-todo task spec: the CLI runs only against a temp
 * copy) never writes `.nukadoko/` state into the committed example
 * directory.
 */
export async function copyExampleToTempDir(name: string): Promise<string> {
  await mkdir(tempFixturesRoot, { recursive: true });
  const dest = await mkdtemp(path.join(tempFixturesRoot, "example-"));
  await cp(path.join(repoRoot, "examples", name), dest, { recursive: true });
  return dest;
}

/**
 * A fresh, genuinely empty project directory — for `nuka init`, which
 * refuses to run at all against a directory that already has a
 * `nukadoko.config.ts` (m1-init-scaffold task spec, decision 1), so it can't
 * be tested against a copy of any existing fixture. Nested under
 * `tempFixturesRoot` for the same reason `copyFixtureToTempDir` is: files
 * later written here (by `nuka init`/`nuka scaffold`) still resolve bare
 * specifiers like "zod" by walking up to this repo's own node_modules.
 */
export async function createEmptyTempDir(): Promise<string> {
  await mkdir(tempFixturesRoot, { recursive: true });
  return mkdtemp(path.join(tempFixturesRoot, "empty-"));
}

const nukadokoShimDir = path.join(tempFixturesRoot, "node_modules", "nukadoko");

/**
 * Makes the bare specifier `"nukadoko"` resolve, for any file created under
 * `tempFixturesRoot`, to this repo's own `src/index.ts` — Node's module
 * resolution walks up *every* ancestor directory's `node_modules`, so one
 * shim placed at `tempFixturesRoot` covers every temp project nested under
 * it, whether created by this file's `createEmptyTempDir` or
 * `copyFixtureToTempDir`.
 *
 * `nuka init`/`nuka scaffold` generate real-user-facing artifacts that
 * import from `"nukadoko"` (the published package name), not from a
 * fixture-relative shim path (m1-init-scaffold task spec: the generated
 * output itself should look like what a real user gets) — but the
 * published package doesn't exist yet in this repo's own `node_modules`.
 * This is the same stand-in `tests/fixtures/*\/nukadoko-shim.ts` provides
 * for hand-written fixtures, just packaged as a real `node_modules` entry
 * so the bare specifier itself — which generated files use, unlike
 * fixtures — resolves.
 */
export async function ensureNukadokoShim(): Promise<void> {
  await mkdir(nukadokoShimDir, { recursive: true });
  await writeFile(
    path.join(nukadokoShimDir, "package.json"),
    `${JSON.stringify(
      {
        name: "nukadoko",
        version: "0.0.0",
        type: "module",
        exports: { ".": "./index.js", "./compat": "./compat.js" },
      },
      null,
      2,
    )}\n`,
  );
  const target = path.join(repoRoot, "src", "index.js");
  const relative = path.relative(nukadokoShimDir, target).split(path.sep).join("/");
  const specifier = relative.startsWith(".") ? relative : `./${relative}`;
  await writeFile(path.join(nukadokoShimDir, "index.ts"), `export * from "${specifier}";\n`);

  // "./compat" subpath (m2a-compat-registry task spec: extending this
  // mechanism for it is explicitly permitted) — same re-export trick as the
  // main entry above, pointed at src/compat/index.ts instead, so a test
  // project can resolve `import { Given } from "nukadoko/compat"` the same
  // way a real downstream package's own resolved "nukadoko" dependency will,
  // via the real package.json's own `"./compat"` export (kept in sync by
  // hand — see package.json).
  const compatTarget = path.join(repoRoot, "src", "compat", "index.js");
  const compatRelative = path.relative(nukadokoShimDir, compatTarget).split(path.sep).join("/");
  const compatSpecifier = compatRelative.startsWith(".") ? compatRelative : `./${compatRelative}`;
  await writeFile(
    path.join(nukadokoShimDir, "compat.ts"),
    `export * from "${compatSpecifier}";\n`,
  );
}

const execFileAsync = promisify(execFile);

/**
 * `git init`s `dir` (already containing whatever files a test wants
 * committed) and commits everything in it in one commit — the means of
 * running `git init` in a temp directory that src/run/probe-git.ts's own
 * tests need (m4a-run-provenance task spec). `dir`'s own `.git` is what git
 * actually resolves, closest-ancestor-wins, regardless of `dir` sitting
 * inside this repo's own working tree (e.g. under `tempFixturesRoot` above)
 * — a nested repo never needs its ancestor's `.git` consulted at all. The
 * identity is configured `--local` (this call's own `cwd`), never
 * `--global`: a test must not read or write the machine's real git config.
 * Returns the resulting commit's full 40-character sha, for a test to
 * assert `git.commit` against.
 */
export async function initGitRepo(dir: string): Promise<string> {
  const git = (args: string[]) => execFileAsync("git", args, { cwd: dir, encoding: "utf8" });
  await git(["init", "-q"]);
  await git(["config", "user.email", "nukadoko-tests@example.invalid"]);
  await git(["config", "user.name", "nukadoko tests"]);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "initial"]);
  const { stdout } = await git(["rev-parse", "HEAD"]);
  return stdout.trim();
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

// fb5-run-output task spec: `nuka run` now always writes its own progress
// output to stderr (a scenario boundary line, a step line per step, where
// output landed, and a one-line summary — src/run/progress-log.ts), so a
// pre-existing test asserting a *clean* run's stderr is empty needs to say
// that modulo this new, expected chatter instead. Recognizing exactly the
// four line shapes that module writes (never a partial/fuzzy match) keeps
// this a precise complement of "no progress line here" rather than a
// blanket swallow that could also hide a real warning.
const SCENARIO_BOUNDARY_LINE = /^scenario \d+\/\d+  /;
const STEP_PROGRESS_LINE = /^ {2}step \d+\/\d+  /;
const OUTPUT_LOCATION_LINE = /^(?:receipts|scenarios|allure|messages)\b/;
const RUN_SUMMARY_LINE = /^\d+ scenarios?: \d+ passed, \d+ failed {2}\(/;

/** Strips `nuka run`'s own progress-log lines (fb5-run-output task spec)
 * out of captured stderr text, leaving any warning/error line a test still
 * wants to assert on. Used in place of a bare `stderr.text()` wherever a
 * test's own point predates this feature and was really asserting "nothing
 * unexpected happened", not "this command is silent". */
export function stripRunProgressLines(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !SCENARIO_BOUNDARY_LINE.test(line) &&
        !STEP_PROGRESS_LINE.test(line) &&
        !OUTPUT_LOCATION_LINE.test(line) &&
        !RUN_SUMMARY_LINE.test(line),
    )
    .join("\n");
}
