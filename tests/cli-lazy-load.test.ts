import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: a command loads only its own modules, and `nuka run`
// imports each step file once. `--help` and `--version` run in a child
// process under a `node:module` load hook that records every module URL,
// because only a fresh process shows what one invocation loaded. The step
// file count goes through runCli in-process: each discovery imports step
// files under a fresh loader namespace, so the module cache of the test
// process does not hide a second import.

const execFileAsync = promisify(execFile);

// The engine directories a command that prints help or a version must not
// reach: executing scenarios, writing reports, the cucumber-js layer, and
// the MCP client.
const HEAVY_DIRS = ["run", "report", "compat", "mcp"];

describe("nuka --help and nuka --version", () => {
  let hookDir: string;
  let hookPath: string;

  beforeAll(async () => {
    hookDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-load-hook-"));
    hookPath = path.join(hookDir, "record-loads.mjs");
    await writeFile(
      hookPath,
      [
        'import { registerHooks } from "node:module";',
        'import { writeFileSync } from "node:fs";',
        "const urls = [];",
        "registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });",
        'process.on("exit", () => writeFileSync(process.env.LOADS_OUT, urls.join("\\n")));',
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(hookDir, { recursive: true, force: true });
  });

  async function loadedModules(flag: string): Promise<string[]> {
    const out = path.join(hookDir, `loads${flag}.txt`);
    await execFileAsync(process.execPath, ["--import", pathToFileURL(hookPath).href, "dist/cli.js", flag], {
      cwd: repoRoot,
      env: { ...process.env, LOADS_OUT: out },
    });
    return (await readFile(out, "utf8")).split("\n");
  }

  for (const flag of ["--help", "--version"]) {
    it(`${flag} loads nothing under ${HEAVY_DIRS.map((dir) => `src/${dir}`).join(", ")}`, async () => {
      const urls = await loadedModules(flag);
      const own = pathToFileURL(repoRoot).href;
      // The control: the CLI's own modules are recorded, so an empty
      // result below means none of the heavy ones loaded, not that the hook
      // saw nothing.
      expect(urls).toContain(`${own}/dist/cli/run-cli.js`);
      const heavy = urls.filter((url) =>
        HEAVY_DIRS.some((dir) => url.startsWith(`${own}/dist/${dir}/`) || url.startsWith(`${own}/src/${dir}/`)),
      );
      expect(heavy).toEqual([]);
    });
  }
});

describe("a step file's module scope under nuka run", () => {
  let rootDir: string;
  let loadsLog: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    loadsLog = path.join(rootDir, "loads.log");
    const stepPath = path.join(rootDir, "features", "steps", "visitor-arrives.ts");
    const source = await readFile(stepPath, "utf8");
    await writeFile(
      stepPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(new URL("../../loads.log", import.meta.url), "loaded\\n");\n${source}`,
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function loadCount(): Promise<number> {
    return (await readFile(loadsLog, "utf8")).split("\n").filter((line) => line === "loaded").length;
  }

  for (const args of [["run"], ["run", "--no-check"]]) {
    it(`runs once per nuka ${args.join(" ")}`, async () => {
      const stderr = createCaptureSink();
      const exitCode = await runCli([...args, "features/greeting.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      });
      expect(exitCode, stderr.text()).toBe(0);
      expect(await loadCount()).toBe(1);
    });
  }
});
