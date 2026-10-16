import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyFixtureToTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: nukadoko's own loaders run tsx with its disk cache off,
// unless the user set TSX_DISABLE_CACHE. tsx reads the variable once, when
// its main module (`tsx/dist/index-<hash>.mjs`) evaluates, so the
// observation is a `node:module` load hook in a child `nuka` process that
// puts one line at the top of that module's source, recording the value as
// the module starts to evaluate. Recording it in the hook itself would be
// too early: an ES module graph is loaded whole before any of it evaluates,
// so the hook runs before nukadoko's own modules have set anything. A second check runs `nuka run` with the OS temp
// directory pointed at an empty directory and looks for the cache directory
// tsx would make there.

const execFileAsync = promisify(execFile);

function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TSX_DISABLE_CACHE;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

describe("TSX_DISABLE_CACHE when tsx loads under nuka check", () => {
  let hookDir: string;
  let hookPath: string;
  let rootDir: string;

  beforeAll(async () => {
    hookDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-tsx-env-hook-"));
    hookPath = path.join(hookDir, "record-tsx-env.mjs");
    // The injected line pushes onto a global the hook file owns, and the
    // exit handler writes it out for the test to read.
    const hook = String.raw`import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const seen = (globalThis.__tsxEnvSeen = []);
const record = "globalThis.__tsxEnvSeen.push(process.env.TSX_DISABLE_CACHE ?? null);\n";
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!/\/tsx\/dist\/index-[^/]+\.mjs$/.test(url)) return result;
    return { ...result, source: record + String(result.source) };
  },
});
process.on("exit", () => writeFileSync(process.env.TSX_ENV_OUT, JSON.stringify(seen)));
`;
    await writeFile(hookPath, hook);
  });

  afterAll(async () => {
    await rm(hookDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function valuesAtTsxLoad(parentValue: string | undefined): Promise<(string | null)[]> {
    const out = path.join(hookDir, `seen-${parentValue ?? "unset"}.json`);
    await execFileAsync(
      process.execPath,
      ["--import", pathToFileURL(hookPath).href, path.join(repoRoot, "dist", "cli.js"), "check", "features/greeting.feature"],
      { cwd: rootDir, env: childEnv({ TSX_DISABLE_CACHE: parentValue, TSX_ENV_OUT: out }) },
    );
    return JSON.parse(await readFile(out, "utf8")) as (string | null)[];
  }

  it('is "1" when the parent did not set it', async () => {
    // Non-empty is the control: the hook saw tsx's main module load, so the
    // value below is the one tsx read.
    const values = await valuesAtTsxLoad(undefined);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value === "1")).toBe(true);
  });

  it("keeps the value the parent set", async () => {
    const values = await valuesAtTsxLoad("0");
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value === "0")).toBe(true);
  });
});

describe("tsx's cache directory under nuka run", () => {
  let rootDir: string;
  let tempDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    tempDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-tsx-tmp-"));
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
    await rm(tempDir, { recursive: true, force: true });
  });

  async function tempEntriesAfterRun(parentValue: string | undefined): Promise<string[]> {
    // tsx puts its cache under os.tmpdir(), which reads TMPDIR on POSIX and
    // TEMP or TMP on Windows.
    await execFileAsync(process.execPath, [path.join(repoRoot, "dist", "cli.js"), "run", "features/greeting.feature"], {
      cwd: rootDir,
      env: childEnv({ TSX_DISABLE_CACHE: parentValue, TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir }),
    });
    return (await readdir(tempDir)).filter((name) => name.startsWith("tsx"));
  }

  it("creates no tsx cache entries", async () => {
    expect(await tempEntriesAfterRun(undefined)).toEqual([]);
  });

  it("creates them when the user turns the cache on with an empty value", async () => {
    // The control: tsx tests the variable for truthiness, so an empty value
    // keeps its cache on, and the directory does appear. Without this, an
    // empty result above could mean tsx writes its cache somewhere else.
    expect(await tempEntriesAfterRun("")).not.toEqual([]);
  });
});
