import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE_NAME, loadConfig } from "../config/load-config.js";
import { configSchema } from "../config/schema.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka init`'s actual work (this task's spec, decision 1),
// kept out of run-cli.ts so it's unit-testable without going through yargs
// (same split as cli/do.ts and cli/session.ts). One command, one all-or-
// nothing outcome:
//
//   - If `nukadoko.config.ts` already exists, refuse the whole command
//     (stderr + exit 1, nothing written) before touching the filesystem at
//     all. A partial init would leave a state no later run can tell apart
//     from "fully initialized" or "never initialized" — refusing up front is
//     the only way to keep that question answerable.
//   - Otherwise, generate the config, the (empty) steps directory, and the
//     `.gitignore` entry, printing each path actually written to stdout as
//     it happens (diagnostics go to stderr — this task's spec's stdout
//     discipline: an agent parses stdout, so it carries only paths).
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
// dir` (t2-init-features-dir task spec) is the one way to override
// `featuresDir` specifically: without it, this stays exactly as it was.
//
// t2-init-features-dir task spec: when `--features-dir` is given, its
// (normalized) value drives both the steps directory `mkdir` below *and*
// the generated config's own `featuresDir` field — the two must never
// diverge, since divergence is exactly the bug this option exists to fix
// (a hand-edited config's `featuresDir` no longer matching where `init`
// actually created `steps/`). It is deliberately left out of the config
// template when omitted (`featuresDirOverride` stays `null`, see
// `configTemplate` below): baking schema.ts's current default into every
// generated config would leave that default frozen in every existing
// project's config the day schema.ts's own default ever changes.

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
 * `normalizeFeaturePath`) — this task's spec says to investigate how this
 * codebase already validates a path argument and align with it rather than
 * invent a new convention, and that is what those two do. Reusing their
 * exact idiom means an absolute value or one containing `..` is accepted
 * as-is here too, same as it already is for those two commands' own feature
 * argument (see src/check/analyze.ts's own comment: "absolute paths
 * accepted as-is").
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
 * Appends `<stateDir>/` to `<rootDir>/.gitignore`, creating the file if it
 * doesn't exist. Returns whether the file was actually written — `false`
 * when the entry was already present, so the caller knows not to report a
 * path that didn't change (this task's spec: "既に行があれば足さない").
 */
async function ensureGitignoreEntry(rootDir: string, stateDir: string): Promise<boolean> {
  const gitignorePath = path.join(rootDir, ".gitignore");
  const entry = `${stateDir}/`;

  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = await readFile(gitignorePath, "utf8");
    const alreadyPresent = existing.split(/\r?\n/).some((line) => line.trim() === entry);
    if (alreadyPresent) {
      return false;
    }
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
  await writeFile(gitignorePath, `${prefix}${entry}\n`);
  return true;
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

  const gitignoreWritten = await ensureGitignoreEntry(rootDir, defaults.stateDir);
  if (gitignoreWritten) {
    stdout.write(".gitignore\n");
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
