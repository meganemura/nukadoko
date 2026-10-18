import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { commandWords } from "../src/cli/init.js";
import { loadConfig } from "../src/config/load-config.js";
import { buildCategories } from "../src/report/allure/categories.js";
import { buildFailureMarker } from "../src/report/allure/map-scenario.js";
import type { ErrorKind } from "../src/record/types.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  removeTempDir,
  repoRoot,
  testsDir,
} from "./helpers/fixtures.js";

// The one line init writes to stderr when nothing else needs saying. These
// tests run init from source, so the package is this checkout.
const NEXT_LINE = `next: read ${path.join(repoRoot, "llms.txt")}, written for an agent: the loop, every command, and every finding code\n`;

// Responsibility: `nuka init` — all
// generated artifacts plus its self-check in an empty directory, the
// refusal of each removed flag by name, the all-or-nothing refusal when
// nukadoko.config.ts already exists, and the .gitignore append (both the
// "file doesn't exist yet" and the "line is already there" branches).
// `ensureNukadokoShim` stands in for the not-yet-published "nukadoko"
// package so the self-check's own `loadConfig`/`discoverSteps` can actually
// resolve the generated config's `import { defineConfig } from "nukadoko"`.
//
// Also `allurerc.mjs`'s own generation (content
// built from `buildCategories()`, never a second hand-typed copy of its
// names), the six-extension existing-config check that keeps `init` from
// ever laying a second, competing Allure config over one already there, and
// (the "process" describe block at the bottom, mirroring skill.test.ts's
// own split) the proof that the file `nuka init` writes is the one Allure
// itself reads: a real failing run, `allure generate` against it with no
// `--config` flag, and its own category output.

const escapeRegExpForTest = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Same technique tests/allure-config-drift.test.ts's own
 * `nameByKindFromEngine` uses: `buildCategories()`'s rules carry a
 * `messageRegex` built from `buildFailureMarker(kind)`, not `kind` itself,
 * so a rule's own kind is recovered by finding which kind's marker its
 * regex was built from. */
function engineNameByKind(): Record<ErrorKind, string> {
  const ALL_KINDS: readonly ErrorKind[] = [
    "args_invalid",
    "result_invalid",
    "binding_invalid",
    "world_invalid",
    "timeout",
    "unsupported",
    "step_error",
  ];
  const rules = buildCategories();
  const result = {} as Record<ErrorKind, string>;
  for (const kind of ALL_KINDS) {
    const marker = buildFailureMarker(kind);
    const rule = rules.find(
      (r) => typeof r.messageRegex === "string" && r.messageRegex.startsWith(escapeRegExpForTest(marker)),
    );
    expect(rule, `categories.ts has no rule for kind ${kind}`).toBeDefined();
    result[kind] = rule?.name ?? "";
  }
  return result;
}

interface GeneratedAllurercCategory {
  name?: string;
  matchers?: Array<{ labels?: Record<string, string> }>;
}

async function loadGeneratedAllurerc(
  rootDir: string,
): Promise<{ categories: GeneratedAllurercCategory[]; historyPath?: string }> {
  const mod = (await import(pathToFileURL(path.join(rootDir, "allurerc.mjs")).href)) as {
    default: { categories: GeneratedAllurercCategory[]; historyPath?: string };
  };
  return mod.default;
}

const ALLURE_CONFIG_FILENAMES = [
  "allurerc.js",
  "allurerc.mjs",
  "allurerc.cjs",
  "allurerc.json",
  "allurerc.yaml",
  "allurerc.yml",
];

const ESM_PACKAGE_JSON = `${JSON.stringify({ name: "esm-project", private: true, type: "module" }, null, 2)}\n`;

/** Every file and directory under `rootDir`, root-relative and sorted. */
async function fileSet(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { recursive: true });
  return entries.map((entry) => entry.split(path.sep).join("/")).sort();
}

describe("nuka init", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    await writeFile(path.join(rootDir, "package.json"), ESM_PACKAGE_JSON);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes the config, the steps directory, .gitignore, and the package.json script, and nothing Allure-shaped", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(stdout.text()).toBe("nukadoko.config.ts\nfeatures/steps\n.gitignore\npackage.json\n".replace(/\//g, path.sep));
    expect(await fileSet(rootDir)).toEqual([
      ".gitignore",
      "features",
      "features/steps",
      "nukadoko.config.ts",
      "package.json",
    ]);

    expect(await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8")).toBe(
      [
        'import { defineConfig } from "nukadoko";',
        "",
        "export default defineConfig({",
        '  // Every config key nukadoko reads, one line each: docs/spec.md, "Environments and secrets"',
        "});",
        "",
      ].join("\n"),
    );
    expect(await readFile(path.join(rootDir, ".gitignore"), "utf8")).toBe(".nukadoko/\n.env\n.env.*\n!.env.example\n");
    expect(JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"))).toEqual({
      name: "esm-project",
      private: true,
      type: "module",
      scripts: { "test:scenarios": "nuka run" },
    });

    const config = await loadConfig(rootDir);
    expect(config.allure).toBeUndefined();
    expect(config.messages).toBeUndefined();
  });

  it("with --server and --server-url, writes baseURL, a server fixture that starts the command, and a request that needs it", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init", "--server", "node  src/server.ts --quiet", "--server-url", "http://127.0.0.1:4567"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8")).toBe(
      [
        'import { defineConfig, defineFixtures, runServer, type RunningServer } from "nukadoko";',
        "",
        "export default defineConfig({",
        '  // Every config key nukadoko reads, one line each: docs/spec.md, "Environments and secrets"',
        '  baseURL: "http://127.0.0.1:4567",',
        "  fixtures: defineFixtures({",
        "    // The program under test, started for each scenario that sends a request and stopped",
        "    // after it. It has to listen at baseURL; runServer waits until the port accepts a connection.",
        "    server: async ({ baseURL }, use) => {",
        '      const server = await runServer("node", ["src/server.ts","--quiet"], { url: baseURL });',
        "      await use(server);",
        "      await server.stop();",
        "    },",
        "    // Playwright's own request, built after server: a step that sends a request starts it.",
        "    request: async ({ request, server }, use) => {",
        "      void server;",
        "      await use(request);",
        "    },",
        "  }),",
        "});",
        "",
        'declare module "nukadoko" {',
        "  interface StepFixtures {",
        "    server: RunningServer;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect((await loadConfig(rootDir)).baseURL).toBe("http://127.0.0.1:4567");
  });

  it("refuses --server without --server-url, --server-url alone, and a URL that is not http, writing nothing", async () => {
    const refusal = async (argv: string[]) => {
      const stderr = createCaptureSink();
      const exitCode = await runCli(["init", ...argv], { rootDir, stdout: createCaptureSink(), stderr });
      return { exitCode, stderr: stderr.text() };
    };

    expect(await refusal(["--server", "node src/server.ts"])).toEqual({
      exitCode: 2,
      stderr:
        "refused\tinvalid-arguments\t-\tRefusing to init: --server needs --server-url, the URL the program listens at: nukadoko waits for it and sends every request there, and the program alone knows it; nothing was written\n" +
        "  fix: Pass --server-url with the URL the program listens at, such as http://127.0.0.1:3000.\n",
    });
    expect(await refusal(["--server-url", "http://127.0.0.1:3000"])).toEqual({
      exitCode: 2,
      stderr:
        "refused\tinvalid-arguments\t-\tRefusing to init: --server-url names the URL the --server command listens at, and no --server was given; nothing was written\n" +
        "  fix: Pass --server with the command that starts the program under test, beside --server-url http://127.0.0.1:3000.\n",
    });
    expect(await refusal(["--server", "node src/server.ts", "--server-url", "127.0.0.1:3000"])).toEqual({
      exitCode: 2,
      stderr:
        'refused\tinvalid-arguments\t-\tRefusing to init: --server-url needs an http or https URL, and got "127.0.0.1:3000"; nothing was written\n' +
        "  fix: Pass --server-url as an http URL with a host and a port.\n",
    });
    expect(await fileSet(rootDir)).toEqual(["package.json"]);
  });

  it("starts the --server command for a --request step, and the scenario passes with no hand edit", async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    await mkdir(path.join(rootDir, "src"));
    await writeFile(
      path.join(rootDir, "src", "server.ts"),
      `import { createServer } from "node:http";\ncreateServer((req, res) => res.end(req.url === "/health" ? "ok" : "no")).listen(${port}, "127.0.0.1");\n`,
    );
    const quiet = { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() };

    // The command runs in the directory nuka runs in, which is not rootDir in this process.
    const server = `node ${path.join(rootDir, "src", "server.ts")}`;
    expect(await runCli(["init", "--server", server, "--server-url", `http://127.0.0.1:${port}`], quiet)).toBe(0);
    await writeFile(
      path.join(rootDir, "features", "health.feature"),
      'Feature: health\n  Scenario: ok\n    When I request "/health"\n    Then the body is "ok"\n',
    );
    expect(await runCli(["scaffold", "send", "--pattern", "I request {path:string}", "--request", "GET {path}"], quiet)).toBe(0);
    expect(await runCli(["scaffold", "body-is", "--pattern", "the body is {text:string}", "--then", "--from", "send.body"], quiet)).toBe(0);
    const run = { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() };
    const exitCode = await runCli(["run"], run);

    expect(exitCode).toBe(0);
    expect(`${run.stdout.text()}${run.stderr.text()}`).toMatch(/^1 scenario(s)?: 1 passed, 0 failed {2}\(\d+s\)$/m);
  });

  it("with --allure, also writes allurerc.mjs and the results directory, and turns the Allure emitter on", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init", "--allure"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(stdout.text().trim().split("\n")).toEqual([
      "nukadoko.config.ts",
      path.join("features", "steps"),
      ".gitignore",
      "package.json",
      path.join(".nukadoko", "export", "allure-results"),
      "allurerc.mjs",
    ]);
    expect(await fileSet(rootDir)).toEqual([
      ".gitignore",
      ".nukadoko",
      ".nukadoko/export",
      ".nukadoko/export/allure-results",
      "allurerc.mjs",
      "features",
      "features/steps",
      "nukadoko.config.ts",
      "package.json",
    ]);
    expect(await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8")).toContain("  allure: {},\n");

    const config = await loadConfig(rootDir);
    expect(config.allure).toEqual({});
    expect(config.messages).toBeUndefined();
  });

  it("keeps an existing test:scenarios script and the file's own indentation, and says it kept it", async () => {
    const own = `${JSON.stringify({ type: "module", scripts: { "test:scenarios": "cucumber-js" } }, null, 4)}\n`;
    await writeFile(path.join(rootDir, "package.json"), own);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain("package.json");
    expect(stderr.text()).toBe(
      'package.json already has a test:scenarios script ("cucumber-js"); nuka init left it as it is, so run "nuka run" directly or point that script at it\n' +
        NEXT_LINE,
    );
    expect(await readFile(path.join(rootDir, "package.json"), "utf8")).toBe(own);
  });

  it("says nothing about a test:scenarios script that already runs nuka run", async () => {
    const own = `${JSON.stringify({ type: "module", scripts: { "test:scenarios": "nuka run" } }, null, 2)}\n`;
    await writeFile(path.join(rootDir, "package.json"), own);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain("package.json");
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(await readFile(path.join(rootDir, "package.json"), "utf8")).toBe(own);
  });

  it("adds the script beside the existing ones, in the file's own indentation", async () => {
    await writeFile(
      path.join(rootDir, "package.json"),
      `${JSON.stringify({ type: "module", scripts: { test: "vitest" } }, null, 4)}\n`,
    );

    const exitCode = await runCli(["init"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    expect(await readFile(path.join(rootDir, "package.json"), "utf8")).toBe(
      `${JSON.stringify(
        { type: "module", scripts: { test: "vitest", "test:scenarios": "nuka run" } },
        null,
        4,
      )}\n`,
    );
  });

  it("says on stderr that no script was added when there is no package.json", async () => {
    await rm(path.join(rootDir, "package.json"));
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain("package.json");
    expect(stderr.text()).toBe(
      'No readable package.json, so no test:scenarios script was added; run "nuka run" directly\n' + NEXT_LINE,
    );
  });

  it("appends the steps glob and the config to a plain tsconfig.json include, and changes nothing else", async () => {
    await writeFile(
      path.join(rootDir, "tsconfig.json"),
      '{\n    "compilerOptions": { "strict": true },\n    "include": ["src/**/*", "test/**/*"]\n}\n',
    );
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(stdout.text()).toBe(
      "nukadoko.config.ts\nfeatures/steps\n.gitignore\npackage.json\ntsconfig.json\n".replace(/\//g, path.sep),
    );
    expect(await readFile(path.join(rootDir, "tsconfig.json"), "utf8")).toBe(
      '{\n    "compilerOptions": { "strict": true, "rewriteRelativeImportExtensions": true },\n    "include": ["src/**/*", "test/**/*", "features/**/*", "nukadoko.config.ts"]\n}\n',
    );
  });

  it("adds one entry per line to a multi-line include, and leaves an entry that already covers the steps alone", async () => {
    await writeFile(
      path.join(rootDir, "tsconfig.json"),
      '{\n\t"include": [\n\t\t"src",\n\t\t"features/**"\n\t]\n}',
    );
    const stdout = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("tsconfig.json\n");
    expect(await readFile(path.join(rootDir, "tsconfig.json"), "utf8")).toBe(
      '{\n\t"include": [\n\t\t"src",\n\t\t"features/**",\n\t\t"nukadoko.config.ts"\n\t]\n}',
    );
  });

  it("leaves a tsconfig.json that extends a missing file alone, and says it did not check the option", async () => {
    const text = '{\n  "extends": "./tsconfig.base.json"\n}\n';
    await writeFile(path.join(rootDir, "tsconfig.json"), text);
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain("tsconfig.json");
    expect(stderr.text()).toBe(
      'tsconfig.json extends "./tsconfig.base.json", which nuka init could not read, so it did not check whether rewriteRelativeImportExtensions or allowImportingTsExtensions is set; tsc refuses the .ts imports nuka scaffold writes unless one of them is set\n' + NEXT_LINE,
    );
    expect(await readFile(path.join(rootDir, "tsconfig.json"), "utf8")).toBe(text);
  });

  it("says nothing when a package tsconfig.json extends sets the option", async () => {
    const text = '{\n  "extends": "@acme/tsconfig"\n}\n';
    await writeFile(path.join(rootDir, "tsconfig.json"), text);
    await mkdir(path.join(rootDir, "node_modules", "@acme", "tsconfig"), { recursive: true });
    await writeFile(path.join(rootDir, "node_modules", "@acme", "tsconfig", "package.json"), '{ "name": "@acme/tsconfig" }\n');
    await writeFile(
      path.join(rootDir, "node_modules", "@acme", "tsconfig", "tsconfig.json"),
      '{ "compilerOptions": { "allowImportingTsExtensions": true, "noEmit": true } }\n',
    );
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain("tsconfig.json");
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(await readFile(path.join(rootDir, "tsconfig.json"), "utf8")).toBe(text);
  });

  it("names the missing option when no file in the extends chain sets it", async () => {
    const text = '{\n  "extends": "./tsconfig.base"\n}\n';
    await writeFile(path.join(rootDir, "tsconfig.json"), text);
    await writeFile(path.join(rootDir, "tsconfig.base.json"), '{ "extends": "./tsconfig.strict.json", "compilerOptions": { "module": "nodenext" } }\n');
    await writeFile(path.join(rootDir, "tsconfig.strict.json"), '{ "compilerOptions": { "strict": true } }\n');
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain("tsconfig.json");
    expect(stderr.text()).toBe(
      'tsconfig.json has no compilerOptions of its own, and no file it extends sets rewriteRelativeImportExtensions or allowImportingTsExtensions; tsc refuses the .ts imports nuka scaffold writes unless one of them is set, so add "rewriteRelativeImportExtensions": true to compilerOptions\n' + NEXT_LINE,
    );
    expect(await readFile(path.join(rootDir, "tsconfig.json"), "utf8")).toBe(text);
  });

  it("does not add the option to compilerOptions when a file it extends already sets it", async () => {
    const text = '{\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": { "strict": true }\n}\n';
    await writeFile(path.join(rootDir, "tsconfig.json"), text);
    await writeFile(path.join(rootDir, "tsconfig.base.json"), '{ "compilerOptions": { "rewriteRelativeImportExtensions": false } }\n');
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(await readFile(path.join(rootDir, "tsconfig.json"), "utf8")).toBe(text);
  });

  it("adds the entries in place to a tsconfig.json with a comment and trailing commas, and keeps both", async () => {
    const text = '{\n  // the project\'s own sources\n  "include": ["src",],\n}\n';
    await writeFile(path.join(rootDir, "tsconfig.json"), text);
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("tsconfig.json\n");
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(await readFile(path.join(rootDir, "tsconfig.json"), "utf8")).toBe(
      '{\n  // the project\'s own sources\n  "include": ["src", "features/**/*", "nukadoko.config.ts",],\n}\n',
    );
  });

  it("says nothing about tsconfig.json, and writes nothing to it, when its include already covers both", async () => {
    const text = JSON.stringify({ include: ["src", "features/**/*.ts", "nukadoko.config.ts"] });
    await writeFile(path.join(rootDir, "tsconfig.json"), text);
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain("tsconfig.json");
    expect(stderr.text()).toBe(NEXT_LINE);
    expect(await readFile(path.join(rootDir, "tsconfig.json"), "utf8")).toBe(text);
  });

  it("omits featuresDir from the generated config, so the default stays undeclared", async () => {
    const exitCode = await runCli(["init"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);

    const configContent = await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8");
    expect(configContent).not.toContain("featuresDir");
  });

  it("refuses the whole command when nukadoko.config.ts already exists, writing nothing", async () => {
    const existingConfig =
      'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), existingConfig);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).not.toBe("");

    expect(await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8")).toBe(existingConfig);
    expect(existsSync(path.join(rootDir, "features"))).toBe(false);
    expect(existsSync(path.join(rootDir, ".gitignore"))).toBe(false);
  });

  const ENV_LINES = "init always adds .env, .env.*, and !.env.example to .gitignore.";
  it.each([
    [["--base-url", "https://example.com"], "nuka init --base-url is removed: set baseURL in the generated config after init."],
    [
      ["--features-dir", "e2e"],
      "nuka init --features-dir is removed: init creates features/steps; for another directory, set featuresDir in the generated config after init and move steps/ there.",
    ],
    [["--env-files"], `nuka init --env-files is removed: ${ENV_LINES}`],
    [["--env"], `nuka init --env is removed: ${ENV_LINES}`],
  ])("refuses %j by name, says what replaces it, and writes nothing", async (flags, message) => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init", ...flags], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(`refused\tremoved-command\t-\t${message}\n  fix: Use what the message names in its place.\n  do: nuka init --help\n`);
    expect(await fileSet(rootDir)).toEqual(["package.json"]);
  });

  it("appends .nukadoko/, .env, .env.*, and !.env.example to an existing .gitignore", async () => {
    await writeFile(path.join(rootDir, ".gitignore"), "node_modules/\n");

    const stdout = createCaptureSink();
    const exitCode = await runCli(["init"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain(".gitignore");

    const gitignore = await readFile(path.join(rootDir, ".gitignore"), "utf8");
    expect(gitignore).toBe("node_modules/\n.nukadoko/\n.env\n.env.*\n!.env.example\n");
  });

  it("does not duplicate any already-present entry, and doesn't report .gitignore as written when every entry is already there", async () => {
    await writeFile(
      path.join(rootDir, ".gitignore"),
      "node_modules/\n.nukadoko/\n.env\n.env.*\n!.env.example\n",
    );

    const stdout = createCaptureSink();
    const exitCode = await runCli(["init"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain(".gitignore");

    const gitignore = await readFile(path.join(rootDir, ".gitignore"), "utf8");
    for (const entry of [".nukadoko/", ".env", ".env.*", "!.env.example"]) {
      expect(gitignore.split("\n").filter((line) => line === entry)).toHaveLength(1);
    }
  });

  it.each([".nukadoko", "/.nukadoko/", ".nukadoko/**", "/.nukadoko"])(
    "takes an existing %s line for the state directory and leaves .gitignore byte-identical",
    async (line) => {
      const text = `node_modules/\n${line}\n.env\n.env.*\n!.env.example\n`;
      await writeFile(path.join(rootDir, ".gitignore"), text);
      const stdout = createCaptureSink();

      const exitCode = await runCli(["init"], { rootDir, stdout, stderr: createCaptureSink() });

      expect(exitCode).toBe(0);
      expect(stdout.text()).not.toContain(".gitignore");
      expect(await readFile(path.join(rootDir, ".gitignore"), "utf8")).toBe(text);
    },
  );

  it.each([".nukadoko-old", "!.nukadoko/", ".nukadoko/*.json", "sub/.nukadoko/"])(
    "does not take %s for the state directory, and appends .nukadoko/",
    async (line) => {
      await writeFile(path.join(rootDir, ".gitignore"), `${line}\n`);
      const stdout = createCaptureSink();

      const exitCode = await runCli(["init"], { rootDir, stdout, stderr: createCaptureSink() });

      expect(exitCode).toBe(0);
      expect(stdout.text()).toContain(".gitignore");
      expect(await readFile(path.join(rootDir, ".gitignore"), "utf8")).toBe(`${line}\n.nukadoko/\n.env\n.env.*\n!.env.example\n`);
    },
  );

  // The claim init makes about .gitignore: with any accepted spelling of
  // the state directory among unrelated lines, it writes nothing; without
  // one, it appends exactly the one line.
  it("writes .gitignore only when no line names the state directory, and then adds exactly one line", () =>
    hegel.testAsync(
      async (tc) => {
        const accepted = [".nukadoko", "/.nukadoko", ".nukadoko/", "/.nukadoko/", ".nukadoko/**", "/.nukadoko/**"];
        const envLines = [".env", ".env.*", "!.env.example"];
        const other = gs
          .fromRegex("[a-z*!/.-]{1,10}", { fullmatch: true })
          .filter((line) => !accepted.includes(line) && !envLines.includes(line));
        const lines = tc.draw(gs.arrays(other, { maxSize: 5 }));
        const spelling = tc.draw(gs.oneOf(gs.just(null), gs.sampledFrom(accepted)));
        const at = tc.draw(gs.integers({ minValue: 0, maxValue: lines.length }));
        const all = spelling === null ? lines : [...lines.slice(0, at), spelling, ...lines.slice(at)];
        const text = [...all, ...envLines].map((line) => `${line}\n`).join("");
        const dir = await mkdtemp(path.join(rootDir, "case-"));
        await writeFile(path.join(dir, "package.json"), ESM_PACKAGE_JSON);
        await writeFile(path.join(dir, ".gitignore"), text);

        const exitCode = await runCli(["init"], { rootDir: dir, stdout: createCaptureSink(), stderr: createCaptureSink() });

        expect(exitCode).toBe(0);
        const after = await readFile(path.join(dir, ".gitignore"), "utf8");
        expect(after).toBe(spelling === null ? `${text}.nukadoko/\n` : text);
      },
      { testCases: 15, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 120_000);

  it("appends .env, .env.*, and !.env.example (in that order) to a fresh .gitignore", async () => {

    const stdout = createCaptureSink();
    const exitCode = await runCli(["init"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain(".gitignore");

    const lines = (await readFile(path.join(rootDir, ".gitignore"), "utf8")).split("\n");
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
    // Order matters: a negated pattern only re-includes a path excluded by
    // an *earlier* pattern, so !.env.example must come after .env.* or the
    // exclusion never takes effect.
    expect(lines.indexOf("!.env.example")).toBeGreaterThan(lines.indexOf(".env.*"));
  });

  it("does not duplicate an already-present .env line, and still adds the other two", async () => {
    await writeFile(path.join(rootDir, ".gitignore"), "node_modules/\n.env\n");

    const exitCode = await runCli(["init"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);

    const lines = (await readFile(path.join(rootDir, ".gitignore"), "utf8")).split("\n");
    expect(lines.filter((line) => line === ".env")).toHaveLength(1);
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
  });
});

// Responsibility: the CJS door. In a project whose own package.json has no
// "type": "module", Node reads nukadoko.config.ts as CommonJS under
// "type": "commonjs" and reparses it with a warning on every load when the
// field is absent, so `nuka init` writes
// nukadoko.config.mts there instead and says why on stderr. isCommonJsProject (src/config/
// module-kind.ts) is the one place that decision is made; this only
// exercises it through `nuka init` itself.
describe("nuka init: CommonJS projects", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it('writes nukadoko.config.mts, not nukadoko.config.ts, when package.json has no "type": "module", and says why on stderr', async () => {
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "cjs-project", private: true }),
    );

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("nukadoko.config.mts");
    expect(stdout.text()).not.toContain("nukadoko.config.ts\n");
    expect(existsSync(path.join(rootDir, "nukadoko.config.mts"))).toBe(true);
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(false);

    expect(stderr.text()).toBe(
      'package.json has no "type": "module", so nuka init wrote nukadoko.config.mts; write step files as .mts too, since Node loads each .ts file here with a MODULE_TYPELESS_PACKAGE_JSON warning, or add "type": "module" to use .ts with no warning\n' +
        NEXT_LINE,
    );

    // The self-check (loadConfig + discoverSteps) still passed above
    // (exitCode 0) — this is the further proof that a step file placed
    // under the generated layout is actually discoverable too, the same
    // "creates <featuresDir>/steps... and the self-check discovers under
    // it" property the plain (non-CJS) describe block above checks for
    // nukadoko.config.ts.
    await writeFile(
      path.join(rootDir, "features", "steps", "ping.mts"),
      [
        'import { defineStep } from "nukadoko";',
        'import { z } from "zod";',
        "export default defineStep({",
        '  description: "ping",',
        "  args: z.object({}),",
        "  returns: z.object({}),",
        "  run() {",
        "    return {};",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    const stepsStdout = createCaptureSink();
    const stepsExitCode = await runCli(["steps"], {
      rootDir,
      stdout: stepsStdout,
      stderr: createCaptureSink(),
    });
    expect(stepsExitCode).toBe(0);
    expect(stepsStdout.text()).toContain("ping");
  });

  it('writes nukadoko.config.mts and names "type": "commonjs" on stderr when package.json says so', async () => {
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "cjs-project", private: true, type: "commonjs" }),
    );

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(existsSync(path.join(rootDir, "nukadoko.config.mts"))).toBe(true);
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(false);
    expect(stderr.text()).toBe(
      'package.json says "type": "commonjs", so nuka init wrote nukadoko.config.mts; write step files as .mts too, since Node reads .ts here as CommonJS and nukadoko is ESM-only\n' +
        NEXT_LINE,
    );
  });

  it('still writes nukadoko.config.ts, with no CJS notice, when package.json has "type": "module"', async () => {
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "esm-project", private: true, type: "module" }),
    );

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("nukadoko.config.ts");
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
    expect(existsSync(path.join(rootDir, "nukadoko.config.mts"))).toBe(false);
    expect(stderr.text()).toBe(NEXT_LINE);
  });

  it("refuses the whole command when nukadoko.config.mts already exists, the same as nukadoko.config.ts", async () => {
    const existingConfig =
      'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';
    await writeFile(path.join(rootDir, "nukadoko.config.mts"), existingConfig);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).not.toBe("");

    expect(await readFile(path.join(rootDir, "nukadoko.config.mts"), "utf8")).toBe(existingConfig);
    expect(existsSync(path.join(rootDir, "features"))).toBe(false);
    expect(existsSync(path.join(rootDir, ".gitignore"))).toBe(false);
  });
});

describe("nuka init: allurerc.mjs", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes allurerc.mjs with exactly the seven categories.ts (NAME_BY_KIND) rules, no more, no fewer", async () => {
    const exitCode = await runCli(["init", "--allure"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(rootDir, "allurerc.mjs"))).toBe(true);

    const config = await loadGeneratedAllurerc(rootDir);
    expect(config.categories).toHaveLength(7);
    expect(config.categories).toHaveLength(buildCategories().length);

    const nameByKind = engineNameByKind();
    const seenKinds = new Set<string>();
    for (const rule of config.categories) {
      const kind = rule.matchers?.[0]?.labels?.["nukadoko.failure"] as ErrorKind | undefined;
      expect(kind, `rule ${rule.name ?? "?"} has no recoverable kind`).toBeDefined();
      if (kind) {
        seenKinds.add(kind);
        expect(rule.name).toBe(nameByKind[kind]);
      }
    }
    expect(seenKinds).toEqual(new Set(Object.keys(nameByKind)));
  });

  it("writes historyPath under .nukadoko/export/, a sibling of allure-results rather than inside it", async () => {
    const exitCode = await runCli(["init", "--allure"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);

    const config = await loadGeneratedAllurerc(rootDir);
    // Posix-separated regardless of host OS (init.ts's own `allurercTemplate`
    // doc comment): a plain string comparison is enough here since this
    // test always runs on the same OS that generated the file.
    expect(config.historyPath).toBe(".nukadoko/export/allure-history.jsonl");
    // A sibling of allure-results/, never nested inside it: that directory
    // is exactly what a fresh checkout or a "clean copy" step clears
    // between runs, and history has to survive that clearing to be worth
    // writing at all.
    expect(config.historyPath?.startsWith(".nukadoko/export/allure-results")).toBe(false);
  });

  it.each(ALLURE_CONFIG_FILENAMES)(
    "does not write allurerc.mjs when %s already exists, and says so on stderr",
    async (filename) => {
      const existingContent = `not a real allure config, just a marker for ${filename}\n`;
      await writeFile(path.join(rootDir, filename), existingContent);

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["init", "--allure"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toContain(filename);
      expect(stdout.text()).not.toContain("allurerc.mjs");
      expect(await readFile(path.join(rootDir, filename), "utf8")).toBe(existingContent);
      if (filename !== "allurerc.mjs") {
        expect(existsSync(path.join(rootDir, "allurerc.mjs"))).toBe(false);
      }

      // The rest of init still ran; only the allurerc write was skipped.
      expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
      expect(existsSync(path.join(rootDir, "features", "steps"))).toBe(true);
    },
  );
});

const execFileAsync = promisify(execFile);

describe("nuka init: allurerc.mjs is actually read by `allure generate`", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("classifies a real failure under its own category, not Allure 3's built-in Product errors", async () => {
    const initExit = await runCli(["init", "--allure"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(initExit).toBe(0);
    expect(existsSync(path.join(rootDir, "allurerc.mjs"))).toBe(true);

    await writeFile(
      path.join(rootDir, "features", "steps", "always-fails.ts"),
      [
        'import { z } from "zod";',
        'import { defineStep } from "nukadoko";',
        "export default defineStep({",
        '  pattern: "a step that always fails",',
        '  description: "always throws, to prove allurerc.mjs is actually read",',
        "  args: z.object({}),",
        "  returns: z.object({}),",
        "  run() {",
        '    throw new Error("boom, on purpose");',
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, "features", "allurerc-proof.feature"),
      [
        "Feature: allurerc proof",
        "",
        "  Scenario: fails on purpose",
        "    Given a step that always fails",
        "",
      ].join("\n"),
    );

    const runExit = await runCli(["run", "features/allurerc-proof.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(1);

    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    expect(existsSync(resultsDir)).toBe(true);

    const reportDir = path.join(rootDir, "allure-report");
    const allureBin = path.join(repoRoot, "node_modules", ".bin", "allure");
    // No --config flag: this is the auto-detect path decision 2 depends on
    // (Allure 3 finds allurerc.mjs from the current working directory on
    // its own), run from rootDir itself so that directory is `allurerc.mjs`'s
    // own home.
    await execFileAsync(allureBin, ["generate", ".nukadoko/export/allure-results", "--output", "allure-report"], {
      cwd: rootDir,
    });

    const categoriesWidget = JSON.parse(
      readFileSync(path.join(reportDir, "widgets", "categories.json"), "utf8"),
    ) as { roots?: unknown[]; nodes?: Record<string, { name?: string }> };
    const categoryNames = Object.values(categoriesWidget.nodes ?? {})
      .map((node) => node.name)
      .filter((name): name is string => typeof name === "string");

    expect(categoryNames).toContain("Step error");
    expect(categoryNames).not.toContain("Product errors");
  }, 30_000);
});

// The walkthrough's own claim: a project whose tsconfig.json includes only
// its sources needs no hand edit before `tsc` checks what `init` and
// `scaffold` wrote. `--listFilesOnly` is what proves the step file and the
// config are in the program; an exit code of 0 alone would also hold for a
// tsconfig that never reached them.
describe("nuka init: the project's own tsc checks the steps and the config with no hand edit", () => {
  let rootDir: string;

  beforeEach(async () => {
    // Under tests/ so "nukadoko" resolves through the shim to this
    // package's own src/, types included.
    await ensureNukadokoShim();
    const parent = path.join(testsDir, ".tmp-fixtures");
    await mkdir(parent, { recursive: true });
    rootDir = await mkdtemp(path.join(parent, "init-tsconfig-"));
    await writeFile(path.join(rootDir, "package.json"), ESM_PACKAGE_JSON);
    await writeFile(
      path.join(rootDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            lib: ["ESNext"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: ["node"],
          },
          include: ["src/**/*"],
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src", "greet.ts"), "export const greet = (name: string): string => `Hello, ${name}!`;\n");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("puts the scaffolded step and nukadoko.config.ts in the program, accepts a .ts import, and tsc passes", async () => {
    expect(await runCli(["init"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() })).toBe(0);
    expect(
      await runCli(["scaffold", "greet-someone", "--pattern", "I greet {name:string}"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      }),
    ).toBe(0);

    // The spelling scaffold writes for an import of the project's own code.
    await writeFile(
      path.join(rootDir, "features", "steps", "greeting.ts"),
      'import { greet } from "../../src/greet.ts";\nexport const greeting: string = greet("nuka");\n',
    );

    const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");
    const listed = await execFileAsync(tsc, ["-p", rootDir, "--listFilesOnly"]);
    const programFiles = listed.stdout.split(/\r?\n/).map((file) => path.resolve(file));
    expect(programFiles).toContain(path.join(rootDir, "features", "steps", "greet-someone.ts"));
    expect(programFiles).toContain(path.join(rootDir, "nukadoko.config.ts"));

    const checked = await execFileAsync(tsc, ["-p", rootDir]).then(
      ({ stdout }) => ({ code: 0, output: stdout }),
      (error: { code?: number; stdout?: string }) => ({ code: error.code ?? 1, output: error.stdout ?? "" }),
    );
    expect(checked).toEqual({ code: 0, output: "" });
  });
});

describe("commandWords", () => {
  it("gives back the words a command was joined from, whatever whitespace joins them", () =>
    hegel.test((tc) => {
      const words = tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 6, alphabet: "az09./-=\"'" }), { minSize: 1, maxSize: 5 }));
      const gaps = words.map(() => tc.draw(gs.sampledFrom([" ", "  ", "\t", " \n "])));
      const command = `${tc.draw(gs.sampledFrom(["", " ", "\t"]))}${words.map((word, index) => `${word}${gaps[index]}`).join("")}`;
      expect(commandWords(command)).toEqual(words);
    }));
});
