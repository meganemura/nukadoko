import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE_NAME, loadConfig } from "../config/load-config.js";
import { configSchema } from "../config/schema.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { buildCategories } from "../report/allure/categories.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka init`'s actual work, kept out of run-cli.ts so it's
// unit-testable without going through yargs
// (same split as cli/do.ts and cli/session.ts). One command, one all-or-
// nothing outcome:
//
//   - If `nukadoko.config.ts` already exists, refuse the whole command
//     (stderr + exit 1, nothing written) before touching the filesystem at
//     all. A partial init would leave a state no later run can tell apart
//     from "fully initialized" or "never initialized" — refusing up front is
//     the only way to keep that question answerable.
//   - Otherwise, generate the config, the (empty) steps directory, the
//     `.gitignore` entry, and `allurerc.mjs`, printing each path actually
//     written to stdout as it happens (diagnostics go to stderr — an agent
//     parses stdout, so it carries only paths).
//   - Finish with a self-check: load the config just written and discover
//     its vocabulary for real, the same two calls `nuka steps`/`nuka do`
//     make. A failure here is reported (stderr + exit 1) but the generated
//     files are *not* rolled back — they are already visible on disk, and
//     hiding a failure behind a rollback would only cost the user the
//     ability to look at what init actually produced and fix it directly.
//
// featuresDir/stateDir fall back to `configSchema`'s own defaults
// (`configSchema.parse({})`) rather than hard-coding "features"/".nukadoko"
// here a second time, so this module can never drift from schema.ts's
// source of truth for what "the default project layout" means. `--features-
// dir` is the one way to override `featuresDir` specifically: without it,
// this stays exactly as it was.
//
// When `--features-dir` is given, its (normalized) value drives both the
// steps directory `mkdir` below *and* the generated config's own
// `featuresDir` field — the two must never diverge, since divergence is
// exactly the bug this option exists to fix (a hand-edited config's
// `featuresDir` no longer matching where `init` actually created `steps/`).
// It is deliberately left out of the config template when omitted
// (`featuresDirOverride` stays `null`, see `configTemplate` below): baking
// schema.ts's current default into every generated config would leave that
// default frozen in every existing project's config the day schema.ts's own
// default ever changes.

export interface RunInitOptions {
  rootDir: string;
  /** `--base-url`'s value, or `null` when the flag was omitted. */
  baseUrl: string | null;
  /** `--features-dir`'s value, or `null` when the flag was omitted. */
  featuresDir: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

/**
 * Normalizes `--features-dir`'s raw value relative to `rootDir`, the same
 * `path.relative(rootDir, path.resolve(rootDir, arg))` idiom `nuka check`/
 * `nuka accept` already use for their own path arguments
 * (src/check/analyze.ts's `loadSingleFeature`, src/cli/accept.ts's
 * `normalizeFeaturePath`), rather than inventing a new convention here.
 * Reusing their exact idiom means an absolute value or one containing `..`
 * is accepted as-is here too, same as it already is for those two commands'
 * own feature argument (see src/check/analyze.ts's own comment: "absolute
 * paths accepted as-is").
 *
 * Empty is the one case that convention doesn't already answer for *this*
 * command: a feature-file argument that normalizes to nothing simply fails
 * to `readFileSync` downstream and is reported as "not found" by those
 * commands, but `init` *creates* `<featuresDir>/steps`
 * (`mkdir(..., { recursive: true })`) rather than reading anything, so
 * there is no such natural failure here to fall back on — an empty or
 * self-referencing value (`""`, `"."`, and `"./"` all normalize to `""`)
 * would otherwise silently make `featuresDir` the project root itself.
 * `runInit` below rejects that explicitly, before touching the filesystem
 * (`null` returned in place of throwing, since — unlike scaffold.ts's own
 * `name` check — this needs the *original* raw value for the error
 * message).
 */
function normalizeFeaturesDirArg(rootDir: string, raw: string): string | null {
  const normalized = path.relative(rootDir, path.resolve(rootDir, raw));
  return normalized === "" ? null : normalized;
}

function configTemplate(baseUrl: string | null, featuresDir: string | null): string {
  const fields: string[] = [];
  if (featuresDir !== null) {
    fields.push(`  featuresDir: ${JSON.stringify(featuresDir)},`);
  }
  if (baseUrl !== null) {
    fields.push(`  baseURL: ${JSON.stringify(baseUrl)},`);
  }
  const body = fields.length === 0 ? "{}" : `{\n${fields.join("\n")}\n}`;
  return [
    'import { defineConfig } from "nukadoko";',
    "",
    `export default defineConfig(${body});`,
    "",
  ].join("\n");
}

/**
 * Appends every one of `entries` not already present, as its own exact
 * line, to `<rootDir>/.gitignore` (creating the file if it doesn't exist).
 * An entry already present anywhere in the file is left where it is, never
 * duplicated. New entries are appended in `entries`' own order, which is
 * why callers that need one entry to follow another (`!.env.example` must
 * come after `.env.*`, the pattern it re-includes from, or the exclusion
 * never takes effect) pass them in that order here rather than in two
 * separate calls. Returns whether the file was actually written — `false`
 * when every entry was already present, so the caller knows not to report
 * a path that didn't change.
 */
async function ensureGitignoreEntries(rootDir: string, entries: readonly string[]): Promise<boolean> {
  const gitignorePath = path.join(rootDir, ".gitignore");

  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = await readFile(gitignorePath, "utf8");
  }
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) {
    return false;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
  await writeFile(gitignorePath, `${prefix}${missing.join("\n")}\n`);
  return true;
}

// Allure 3 auto-detects a config under any of these names from the current
// working directory — checking only `.mjs` before writing one would
// silently leave two competing configs in place whenever a project already
// carries its allurerc under any of the other five.
const ALLURE_CONFIG_FILENAMES = [
  "allurerc.js",
  "allurerc.mjs",
  "allurerc.cjs",
  "allurerc.json",
  "allurerc.yaml",
  "allurerc.yml",
] as const;

/** Recovers the `ErrorKind` a `buildCategories()` rule was built for from
 * its own `messageRegex` — the rule itself never carries `kind` as a field,
 * only the escaped
 * `[nukadoko.failure=<kind>]` marker `categories.ts`'s own `escapeRegExp`
 * folded into that string (tests/allure-config-drift.test.ts's
 * `nameByKindFromEngine` recovers it the same way). Throws rather than
 * guessing when a rule doesn't carry that shape, so a future change to
 * categories.ts's own regex format fails loudly here instead of silently
 * generating a config with a missing or empty label match. */
function kindFromMessageRegex(messageRegex: string | RegExp | undefined): string {
  const match =
    typeof messageRegex === "string" ? /^\\\[nukadoko\\\.failure=([a-z_]+)\\\]/.exec(messageRegex) : null;
  const kind = match?.[1];
  if (kind === undefined) {
    throw new Error(
      `nukadoko: could not recover an ErrorKind from a categories.ts rule's messageRegex (${String(messageRegex)})`,
    );
  }
  return kind;
}

/**
 * Builds `allurerc.mjs`'s full content from `buildCategories()`
 * (`src/report/allure/categories.ts`), the same source of truth
 * `examples/allure/allurerc.mjs` is checked against
 * (tests/allure-config-drift.test.ts) — never a second, hand-typed copy of
 * the seven category names.
 *
 * `historyPath` is written unconditionally alongside `categories`: without
 * it, Allure 3's own `generate`/`watch`/`report` never build history at
 * all, regardless of how stable a run's own `historyId` values are
 * (`@allurereport/core`'s own `historyPath` default is `undefined`, and its
 * `report.js` only wires up history when this is set) — a project that
 * skipped this field would see no trend, no regression/fixed transitions,
 * and no flaky detection, with nothing in the report itself pointing at a
 * missing config key as the reason.
 */
function allurercTemplate(historyPathRelative: string): string {
  const entries = buildCategories().map((rule) => {
    if (rule.name === undefined) {
      throw new Error("nukadoko: a categories.ts rule has no name");
    }
    return { kind: kindFromMessageRegex(rule.messageRegex), name: rule.name };
  });

  const categoryLines = entries
    .map(
      ({ kind, name }) =>
        `    {\n      name: ${JSON.stringify(name)},\n      matchers: [{ labels: { "nukadoko.failure": ${JSON.stringify(kind)} } }],\n    },`,
    )
    .join("\n");

  return [
    "// This is an Allure 3 config file, not a nukadoko one. Allure 3's own",
    "// generate/report tooling auto-detects allurerc.{js,mjs,cjs,json,yaml,yml}",
    "// from the current working directory (no --config flag needed), and reads",
    "// its own categories field from there, never from a results directory's",
    "// categories.json (that format is Allure 2's).",
    "//",
    "// What this does: maps each nukadoko.failure=<kind> result label to an",
    "// Allure category name, one rule per ErrorKind. Generated by `nuka init`",
    "// from src/report/allure/categories.ts's own NAME_BY_KIND, the source of",
    "// truth for these names.",
    "//",
    "// historyPath points Allure's own generate/watch/report at a file (not a",
    "// directory) where each run's own history point is appended, kept beside",
    "// the disposable allure-results/ directory rather than inside it so",
    "// clearing results between runs (a fresh CI checkout, a local rerun)",
    "// never discards it. Without this, Allure never builds history, trend, or",
    "// flaky-across-runs detection, no matter how stable a scenario's own",
    "// identity is.",
    "//",
    "// Already have your own allurerc? Merge this categories array (and",
    "// historyPath, if you don't already set one) into it instead of",
    "// replacing the whole file.",
    "//",
    "// Using Allure 2 instead? This file is not needed: nukadoko's own emitter",
    "// already writes a matching categories.json into export/allure-results/ every run.",
    "export default {",
    `  historyPath: ${JSON.stringify(historyPathRelative)},`,
    "  categories: [",
    categoryLines,
    "  ],",
    "};",
    "",
  ].join("\n");
}

/**
 * Writes `<rootDir>/allurerc.mjs` unless a config Allure 3 already
 * auto-detects is present under any of `ALLURE_CONFIG_FILENAMES` — in which
 * case nothing is written, and stderr says which file was found and why
 * nothing happened (never skip silently, the same "diagnostics on stderr"
 * split every other line in this module follows). Returns the path
 * written, relative to `rootDir`, or `null` when nothing was.
 */
async function ensureAllurercFile(
  rootDir: string,
  historyPathRelative: string,
  stderr: WritableSink,
): Promise<string | null> {
  for (const filename of ALLURE_CONFIG_FILENAMES) {
    if (existsSync(path.join(rootDir, filename))) {
      stderr.write(
        `Found an existing ${filename}; leaving it as-is and not writing allurerc.mjs (merge its categories in yourself if you want nukadoko's)\n`,
      );
      return null;
    }
  }

  const allurercPath = path.join(rootDir, "allurerc.mjs");
  await writeFile(allurercPath, allurercTemplate(historyPathRelative));
  return "allurerc.mjs";
}

export async function runInit(options: RunInitOptions): Promise<number> {
  const { rootDir, baseUrl, featuresDir, stdout, stderr } = options;

  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  if (existsSync(configPath)) {
    stderr.write(
      `Refusing to init: ${CONFIG_FILE_NAME} already exists at ${configPath}; nothing was written\n`,
    );
    return 1;
  }

  let featuresDirOverride: string | null = null;
  if (featuresDir !== null) {
    featuresDirOverride = normalizeFeaturesDirArg(rootDir, featuresDir);
    if (featuresDirOverride === null) {
      stderr.write(
        `Invalid --features-dir "${featuresDir}": resolves to the project root itself, which can't hold a nested steps directory\n`,
      );
      return 1;
    }
  }

  const defaults = configSchema.parse({});
  const stepsDirRelative = path.join(featuresDirOverride ?? defaults.featuresDir, "steps");

  await writeFile(configPath, configTemplate(baseUrl, featuresDirOverride));
  stdout.write(`${CONFIG_FILE_NAME}\n`);

  await mkdir(path.join(rootDir, stepsDirRelative), { recursive: true });
  stdout.write(`${stepsDirRelative}\n`);

  // .env/.env.* are ignored because a tracked env file is treated as plain
  // configuration, not a secret source (src/secrets/classify-env-files.ts):
  // its values are read into ctx.env like any other config and are never
  // redacted from a run's own records. Committing .env by mistake is the
  // one path that turns "read into ctx" into "written in plaintext
  // somewhere this tool keeps". `!.env.example` re-includes the one
  // filename teams commit on purpose (a template with no real values). It
  // has to come after .env.* below: a negated pattern only re-includes a
  // path an earlier pattern already excluded.
  const gitignoreWritten = await ensureGitignoreEntries(rootDir, [
    `${defaults.stateDir}/`,
    ".env",
    ".env.*",
    "!.env.example",
  ]);
  if (gitignoreWritten) {
    stdout.write(".gitignore\n");
  }

  // Allure's own CLI (`watch`/`generate`) refuses to start against a
  // results directory that doesn't exist yet, but an empty one is enough
  // (verified against allure 3.14.3: `watch` serves and `generate` produces
  // an empty report). Creating it here — always the schema default, since
  // `--features-dir` never touches `stateDir` — lets `allure watch` already
  // be running before the first `nuka run`, instead of requiring one run to
  // exist first just to make the directory appear.
  const allureResultsDirRelative = path.join(defaults.stateDir, "export", "allure-results");
  await mkdir(path.join(rootDir, allureResultsDirRelative), { recursive: true });
  stdout.write(`${allureResultsDirRelative}\n`);

  // A sibling of allure-results/, in the same export/ directory — a file,
  // not a directory, and never created here: Allure's own history.appendHistory
  // creates its own parent directory on first write (@allurereport/core's own
  // history.js), and creating an empty placeholder ahead of that would only
  // risk the two disagreeing about whether "empty" and "no history yet" are
  // the same thing. Posix-joined (not `path.join`) since this becomes a
  // string literal inside a generated .mjs file, which should read the same
  // on every host OS regardless of which one generated it.
  const historyPathRelative = [defaults.stateDir, "export", "allure-history.jsonl"].join("/");

  const allurercWritten = await ensureAllurercFile(rootDir, historyPathRelative, stderr);
  if (allurercWritten !== null) {
    stdout.write(`${allurercWritten}\n`);
  }

  try {
    const config = await loadConfig(rootDir);
    await discoverSteps(rootDir, config.featuresDir);
  } catch (error) {
    stderr.write(`Self-check failed: ${formatVocabularyError(error)}\n`);
    return 1;
  }

  return 0;
}
