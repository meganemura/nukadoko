import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
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
} from "./helpers/fixtures.js";

// Responsibility: `nuka init` — all
// generated artifacts plus its self-check in an empty directory, --base-url
// threading into the generated config, the all-or-nothing refusal when
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
): Promise<{ categories: GeneratedAllurercCategory[] }> {
  const mod = (await import(pathToFileURL(path.join(rootDir, "allurerc.mjs")).href)) as {
    default: { categories: GeneratedAllurercCategory[] };
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

describe("nuka init", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("generates the config, steps directory, and .gitignore entry, and passes its self-check", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text().trim().split("\n")).toEqual([
      "nukadoko.config.ts",
      path.join("features", "steps"),
      ".gitignore",
      path.join(".nukadoko", "export", "allure-results"),
      "allurerc.mjs",
    ]);

    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
    const configContent = await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8");
    expect(configContent).toContain('from "nukadoko"');
    expect(configContent).toContain("defineConfig");

    expect(existsSync(path.join(rootDir, "features", "steps"))).toBe(true);

    const gitignore = await readFile(path.join(rootDir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".nukadoko/");
  });

  it("creates <stateDir>/export/allure-results and reports its path on stdout", async () => {
    const stdout = createCaptureSink();

    const exitCode = await runCli(["init"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(existsSync(path.join(rootDir, ".nukadoko", "export", "allure-results"))).toBe(true);
    expect(stdout.text()).toContain(path.join(".nukadoko", "export", "allure-results"));
  });

  it("reflects --base-url in the generated config", async () => {
    const exitCode = await runCli(["init", "--base-url", "https://example.com"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);

    const config = await loadConfig(rootDir);
    expect(config.baseURL).toBe("https://example.com");
  });

  it("creates <featuresDir>/steps, records featuresDir in the config, and the self-check discovers under it", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init", "--features-dir", "e2e"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text().trim().split("\n")).toEqual([
      "nukadoko.config.ts",
      path.join("e2e", "steps"),
      ".gitignore",
      path.join(".nukadoko", "export", "allure-results"),
      "allurerc.mjs",
    ]);

    expect(existsSync(path.join(rootDir, "e2e", "steps"))).toBe(true);
    expect(existsSync(path.join(rootDir, "features"))).toBe(false);

    const configContent = await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8");
    expect(configContent).toContain('featuresDir: "e2e"');

    const config = await loadConfig(rootDir);
    expect(config.featuresDir).toBe("e2e");

    // A typed step placed under the non-default featuresDir is what proves
    // the self-check (and later `nuka steps`/`nuka do`) actually discover
    // from `config.featuresDir` rather than the schema's own default
    // ("features") — the self-check looks at that
    // directory.
    await writeFile(
      path.join(rootDir, "e2e", "steps", "ping.ts"),
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

  it("creates <stateDir>/export/allure-results at the default location even when --features-dir is given", async () => {
    const exitCode = await runCli(["init", "--features-dir", "e2e"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(existsSync(path.join(rootDir, ".nukadoko", "export", "allure-results"))).toBe(true);
  });

  it("omits featuresDir from the generated config when --features-dir wasn't given (default stays undeclared)", async () => {
    const exitCode = await runCli(["init"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);

    const configContent = await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8");
    expect(configContent).not.toContain("featuresDir");
  });

  it("rejects an empty --features-dir before writing anything", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();

    const exitCode = await runCli(["init", "--features-dir", ""], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("--features-dir");
    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(false);
  });

  it("refuses the whole command when nukadoko.config.ts already exists, writing nothing", async () => {
    const existingConfig =
      'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), existingConfig);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).not.toBe("");

    expect(await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8")).toBe(existingConfig);
    expect(existsSync(path.join(rootDir, "features"))).toBe(false);
    expect(existsSync(path.join(rootDir, ".gitignore"))).toBe(false);
  });

  it("appends .nukadoko/ to an existing .gitignore", async () => {
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
    expect(gitignore).toBe("node_modules/\n.nukadoko/\n");
  });

  it("does not duplicate an already-present .nukadoko/ line, and doesn't report .gitignore as written", async () => {
    await writeFile(path.join(rootDir, ".gitignore"), "node_modules/\n.nukadoko/\n");

    const stdout = createCaptureSink();
    const exitCode = await runCli(["init"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain(".gitignore");

    const gitignore = await readFile(path.join(rootDir, ".gitignore"), "utf8");
    expect(gitignore.split("\n").filter((line) => line === ".nukadoko/")).toHaveLength(1);
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
    const exitCode = await runCli(["init"], {
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

  it.each(ALLURE_CONFIG_FILENAMES)(
    "does not write allurerc.mjs when %s already exists, and says so on stderr",
    async (filename) => {
      const existingContent = `not a real allure config, just a marker for ${filename}\n`;
      await writeFile(path.join(rootDir, filename), existingContent);

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["init"], { rootDir, stdout, stderr });

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
    const initExit = await runCli(["init"], {
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
