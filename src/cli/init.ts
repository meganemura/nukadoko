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
// featuresDir/stateDir are read from `configSchema`'s own defaults
// (`configSchema.parse({})`) rather than hard-coded here a second time, so
// this module can never drift from schema.ts's source of truth for what
// "the default project layout" means.

export interface RunInitOptions {
  rootDir: string;
  /** `--base-url`'s value, or `null` when the flag was omitted. */
  baseUrl: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

function configTemplate(baseUrl: string | null): string {
  const body = baseUrl === null ? "{}" : `{\n  baseURL: ${JSON.stringify(baseUrl)},\n}`;
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
  const { rootDir, baseUrl, stdout, stderr } = options;

  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  if (existsSync(configPath)) {
    stderr.write(
      `Refusing to init: ${CONFIG_FILE_NAME} already exists at ${configPath}; nothing was written\n`,
    );
    return 1;
  }

  const defaults = configSchema.parse({});
  const stepsDirRelative = path.join(defaults.featuresDir, "steps");

  await writeFile(configPath, configTemplate(baseUrl));
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
