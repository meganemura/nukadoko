import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Responsibility: the one place tests compute absolute paths to
// tests/fixtures/* and the repo root, so individual test files don't each
// re-derive `import.meta.url` -> directory arithmetic.

const here = path.dirname(fileURLToPath(import.meta.url));

export const testsDir = path.resolve(here, "..");
export const repoRoot = path.resolve(testsDir, "..");
export const fixturesDir = path.join(testsDir, "fixtures");

/** Node arguments that run a file from `src/` directly: `src/` imports its
 * own `.ts` files by their `.js` names, which only the loader's resolve
 * hook maps back. */
export const sourceNodeArgs: readonly string[] = [
  "--import",
  pathToFileURL(path.join(repoRoot, "src", "config", "ts-loader.ts")).href,
];

export function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

// Deliberately *inside* the repo tree (under tests/, not the OS temp dir):
// a copied fixture's step files are loaded by Node, which
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
  await ensureNukadokoShim();
  const dest = await mkdtemp(path.join(tempFixturesRoot, "fixture-"));
  await cp(fixture(name), dest, { recursive: true });
  return dest;
}

/**
 * Writes `nukadoko.program.ts` into `rootDir` naming a program nukadoko does
 * not start, listening at `url`: the way a test points a project at the
 * server it started itself. `rest` is spliced into the object as written,
 * such as `environments: { readonly: { policy: "read-only" } }`.
 * `importFrom` is the module `defineProgram` is imported from.
 */
export async function writeUrlProgram(rootDir: string, url: string, rest = "", importFrom = "./nukadoko-shim.js"): Promise<void> {
  await writeFile(
    path.join(rootDir, "nukadoko.program.ts"),
    [
      `import { defineProgram } from ${JSON.stringify(importFrom)};`,
      `export default defineProgram({ url: ${JSON.stringify(url)}${rest === "" ? "" : `, ${rest}`} });`,
      "",
    ].join("\n"),
  );
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Copies a reader-facing project under `examples/<name>/` into a fresh temp
 * directory, the same way `copyFixtureToTempDir` does for `tests/fixtures/*`
 * — nested under `tempFixturesRoot` so `"nukadoko"` and `"zod"` still resolve
 * (see that function's own comment) and so running `nuka run`/`nuka do`
 * against it (the CLI runs only against a temp
 * copy) never writes `.nukadoko/` state into the committed example
 * directory. A `.nukadoko/` already sitting under the example (left by
 * someone exploring it by hand; it is gitignored, so what is there
 * depends on the machine) is not copied: a test that ran against it would
 * inherit that machine's records, and retention would then remove the old
 * ones and say so on stderr, in a test asserting on a clean run.
 */
export async function copyExampleToTempDir(name: string): Promise<string> {
  await ensureNukadokoShim();
  const dest = await mkdtemp(path.join(tempFixturesRoot, "example-"));
  await copyExample(name, dest);
  return dest;
}

/**
 * Copies the examples `names` side by side into one temporary directory,
 * the way they sit under examples/, and returns that directory: for an
 * example whose program file serves a sibling example's app. Each example
 * is copied as copyExampleToTempDir copies one.
 */
export async function copyExamplesToTempDir(names: readonly string[]): Promise<string> {
  await ensureNukadokoShim();
  const dest = await mkdtemp(path.join(tempFixturesRoot, "examples-"));
  for (const name of names) await copyExample(name, path.join(dest, name));
  return dest;
}

async function copyExample(name: string, dest: string): Promise<void> {
  const source = path.join(repoRoot, "examples", name);
  await cp(source, dest, {
    recursive: true,
    filter: (candidate) => path.relative(source, candidate).split(path.sep)[0] !== ".nukadoko",
  });
}

/**
 * A fresh, genuinely empty project directory — for `nuka init`, which
 * refuses to run at all against a directory that already has a
 * `nukadoko.config.ts`, so it can't
 * be tested against a copy of any existing fixture. Nested under
 * `tempFixturesRoot` for the same reason `copyFixtureToTempDir` is: files
 * later written here (by `nuka init`/`nuka scaffold`) still resolve bare
 * specifiers like "zod" by walking up to this repo's own node_modules.
 */
export async function createEmptyTempDir(): Promise<string> {
  await ensureNukadokoShim();
  return mkdtemp(path.join(tempFixturesRoot, "empty-"));
}

const nukadokoShimDir = path.join(tempFixturesRoot, "node_modules", "nukadoko");

/**
 * Every test file calls `ensureNukadokoShim` from its own Vitest worker,
 * while other workers import the shim: each config load and discovery run
 * is a fresh module graph (src/config/ts-loader.ts), so it reads the file
 * from disk again. `writeFile` truncates before it writes, and a reader in
 * that window gets an empty module, so `import { defineConfig } from
 * "nukadoko"` fails in whichever test was loading at that moment. Unchanged
 * content is left alone, and new content lands by rename, which replaces
 * the file in one step.
 */
async function replaceFile(target: string, text: string): Promise<void> {
  const current = await readFile(target, "utf8").catch(() => null);
  if (current === text) return;
  const staging = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(staging, text);
  await rename(staging, target);
}

/**
 * Makes the bare specifier `"nukadoko"` resolve, for any file created under
 * `tempFixturesRoot`, to this repo's own `src/index.ts` — Node's module
 * resolution walks up *every* ancestor directory's `node_modules`, so one
 * shim placed at `tempFixturesRoot` covers every temp project nested under
 * it, whether created by this file's `createEmptyTempDir` or
 * `copyFixtureToTempDir`.
 *
 * Node tries a package's own name before any `node_modules` (a
 * self-reference), through the nearest package.json. Without one of its
 * own, a temp project's nearest is this repository's, whose `exports`
 * point at `dist/`, so a step file would run whatever was last built while
 * the CLI under test runs `src/`. The package.json written last at
 * `tempFixturesRoot` ends that walk there, after the shim is in place.
 *
 * `nuka init`/`nuka scaffold` generate real-user-facing artifacts that
 * import from `"nukadoko"` (the published package name), not from a
 * fixture-relative shim path (the generated
 * output itself should look like what a real user gets) — but the
 * published package doesn't exist yet in this repo's own `node_modules`.
 * This is the same stand-in `tests/fixtures/*\/nukadoko-shim.ts` provides
 * for hand-written fixtures, just packaged as a real `node_modules` entry
 * so the bare specifier itself — which generated files use, unlike
 * fixtures — resolves.
 */
export async function ensureNukadokoShim(): Promise<void> {
  await mkdir(nukadokoShimDir, { recursive: true });
  await replaceFile(
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
  // A `.js` file, because the loader maps `.js` to `.ts` only for a path
  // specifier and the package entry is reached by name; the `.d.ts` beside
  // it gives tsc the same types through `src/`.
  await replaceFile(path.join(nukadokoShimDir, "index.js"), `export * from "${specifier}";\n`);
  await replaceFile(path.join(nukadokoShimDir, "index.d.ts"), `export * from "${specifier}";\n`);

  // "./compat" subpath (extending this
  // mechanism for it is explicitly permitted) — same re-export trick as the
  // main entry above, pointed at src/compat/index.ts instead, so a test
  // project can resolve `import { Given } from "nukadoko/compat"` the same
  // way a real downstream package's own resolved "nukadoko" dependency will,
  // via the real package.json's own `"./compat"` export (kept in sync by
  // hand — see package.json).
  const compatTarget = path.join(repoRoot, "src", "compat", "index.js");
  const compatRelative = path.relative(nukadokoShimDir, compatTarget).split(path.sep).join("/");
  const compatSpecifier = compatRelative.startsWith(".") ? compatRelative : `./${compatRelative}`;
  await replaceFile(path.join(nukadokoShimDir, "compat.js"), `export * from "${compatSpecifier}";\n`);
  await replaceFile(path.join(nukadokoShimDir, "compat.d.ts"), `export * from "${compatSpecifier}";\n`);
  await replaceFile(path.join(tempFixturesRoot, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

const execFileAsync = promisify(execFile);

/**
 * `git init`s `dir` (already containing whatever files a test wants
 * committed) and commits everything in it in one commit — the means of
 * running `git init` in a temp directory that src/run/probe-git.ts's own
 * tests need. `dir`'s own `.git` is what git
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

// `nuka run` now always writes its own progress
// output to stderr (a scenario boundary line, a step line per step, where
// output landed, and a one-line summary — src/run/progress-log.ts), so a
// pre-existing test asserting a *clean* run's stderr is empty needs to say
// that modulo this new, expected chatter instead. Recognizing exactly the
// four line shapes that module writes (never a partial/fuzzy match) keeps
// this a precise complement of "no progress line here" rather than a
// blanket swallow that could also hide a real warning.
const SCENARIO_BOUNDARY_LINE = /^scenario \d+\/\d+  /;
const STEP_PROGRESS_LINE = /^ {2}step \d+\/\d+  /;
const OUTPUT_LOCATION_LINE = /^(?:steps|scenarios|allure|messages|summary|run)\b/;
const RUN_SUMMARY_LINE = /^\d+ scenarios?: \d+ passed, \d+ failed {2}\(/;
// The per-failure lines the summary is followed by, one per scenario that
// did not pass. Chrome of the same kind as the summary itself, so a test
// asserting "nothing unexpected happened" should not see them either.
const FAILED_SCENARIO_LINE = /^failed\tscenario-failed\t/;
// A failed step's error and step record lines sit under its step line, and
// each failed scenario finding is followed by its rerun command.
const STEP_FAILURE_LINE = /^ {6}\S/;
const RERUN_LINE = /^ {2}do: nuka run /;
// The lines a world writes as each phase starts, and once its program is
// ready (src/program/world.ts).
const WORLD_READY_LINE = /^world \S+: /;
// The run's repeated-opening note. Whether it fires depends on what each
// step took on this machine, against a 2% floor, so a test that asserts
// "nothing unexpected happened" would pass or fail with the machine's load.
// tests/run-repeated-prefix.test.ts asserts the note itself.
const PREFIX_NOTE_LINE = /^note\trepeated-scenario-prefix\t/;
const FINDING_DETAIL_LINE = /^ {2}(fix|do): /;

/** Strips `nuka run`'s own progress-log lines
 * out of captured stderr text, leaving any warning/error line a test still
 * wants to assert on. Used in place of a bare `stderr.text()` wherever a
 * test's own point predates this feature and was really asserting "nothing
 * unexpected happened", not "this command is silent". */
export function stripRunProgressLines(text: string): string {
  let inPrefixNote = false;
  return text
    .split("\n")
    .filter((line) => {
      inPrefixNote = PREFIX_NOTE_LINE.test(line) || (inPrefixNote && FINDING_DETAIL_LINE.test(line));
      return !inPrefixNote;
    })
    .filter(
      (line) =>
        !SCENARIO_BOUNDARY_LINE.test(line) &&
        !STEP_PROGRESS_LINE.test(line) &&
        !OUTPUT_LOCATION_LINE.test(line) &&
        !RUN_SUMMARY_LINE.test(line) &&
        !FAILED_SCENARIO_LINE.test(line) &&
        !STEP_FAILURE_LINE.test(line) &&
        !RERUN_LINE.test(line) &&
        !WORLD_READY_LINE.test(line),
    )
    .join("\n");
}

/**
 * `text` without the one finding a command writes when the directory it
 * runs in has no config file. A fixture with no config gets that line
 * on every command; a test about something else drops it here instead of
 * writing a config into the fixture.
 */
export function withoutNoConfigLine(text: string): string {
  return text.replace(/^warning\tconfig-missing\t-\tno nukadoko\.config\.ts or nukadoko\.config\.mts in [^\n]*\n(  fix: [^\n]*\n)?/m, "");
}

/** The run.json of the newest run in `rootDir`'s state directory, as text.
 * A test that ran one `nuka run` reads its run's document here. */
export function latestRunJsonText(rootDir: string, stateDir = ".nukadoko"): string {
  const runsDir = path.join(rootDir, stateDir, "runs");
  // Two runs in one second share the id's time and differ in a random
  // suffix, so the newest is the one that started last, not the last id.
  const texts = readdirSync(runsDir)
    .filter((id) => existsSync(path.join(runsDir, id, "run.json")))
    .map((id) => readFileSync(path.join(runsDir, id, "run.json"), "utf8"));
  if (texts.length === 0) throw new Error(`no run.json under ${runsDir}`);
  const startOf = (text: string): number => Date.parse((JSON.parse(text) as { started_at: string }).started_at);
  return texts.reduce((newest, text) => (startOf(text) > startOf(newest) ? text : newest));
}

/** The newest run's run.json, parsed. */
export function latestRunJson(rootDir: string, stateDir = ".nukadoko"): Record<string, any> {
  return JSON.parse(latestRunJsonText(rootDir, stateDir)) as Record<string, any>;
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The directory of the step record `id`: under `do/` for a `nuka do`
 * record, else inside the run whose `steps/` holds it. An id no directory
 * holds resolves to where a `nuka do` record of that id would be, so a
 * test that expects the record to be gone still gets a path to check. */
export function stepRecordDir(rootDir: string, id: string, stateDir = ".nukadoko"): string {
  const doDir = path.join(rootDir, stateDir, "do", id);
  if (existsSync(doDir)) return doDir;
  const runsDir = path.join(rootDir, stateDir, "runs");
  for (const runId of subdirectories(runsDir)) {
    const dir = path.join(runsDir, runId, "steps", id);
    if (existsSync(dir)) return dir;
  }
  return doDir;
}

/** The http.jsonl lines of the step record `id`, parsed, or `[]` when the
 * step wrote none. */
export function httpLogLines(rootDir: string, id: string, stateDir = ".nukadoko"): Record<string, any>[] {
  const file = path.join(stepRecordDir(rootDir, id, stateDir), "http.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

/** Every step record id in the state directory, `do/` and every run's
 * `steps/` together, sorted. */
export function stepRecordIds(rootDir: string, stateDir = ".nukadoko"): string[] {
  const runsDir = path.join(rootDir, stateDir, "runs");
  return [
    ...subdirectories(path.join(rootDir, stateDir, "do")),
    ...subdirectories(runsDir).flatMap((runId) => subdirectories(path.join(runsDir, runId, "steps"))),
  ].sort();
}

/** The newest run's own directory, absolute: where the paths in its
 * run.json resolve from. */
export function latestRunDir(rootDir: string, stateDir = ".nukadoko"): string {
  return path.join(rootDir, stateDir, "runs", latestRunJson(rootDir, stateDir).run_id as string);
}

/**
 * `nuka check`'s text output with every note, its indented lines, and the
 * `ok: no issues found` line left out, so what is left is the errors and
 * warnings alone. A test whose point is "this passes check" asserts that
 * this is empty, rather than depending on the notes a whole-project check
 * adds for a freshly scaffolded step.
 */
export function withoutCheckNotes(text: string): string {
  let inNote = false;
  return text
    .split("\n")
    .filter((line) => {
      inNote = line.startsWith("note\t") || (inNote && FINDING_DETAIL_LINE.test(line));
      return !inNote && line !== "ok: no issues found";
    })
    .join("\n");
}
