import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { loadConfig } from "../src/config/load-config.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  removeTempDir,
} from "./helpers/fixtures.js";

// Responsibility: `nuka init` (m1-init-scaffold task spec, decision 1) — all
// generated artifacts plus its self-check in an empty directory, --base-url
// threading into the generated config, the all-or-nothing refusal when
// nukadoko.config.ts already exists, and the .gitignore append (both the
// "file doesn't exist yet" and the "line is already there" branches).
// `ensureNukadokoShim` stands in for the not-yet-published "nukadoko"
// package so the self-check's own `loadConfig`/`discoverSteps` can actually
// resolve the generated config's `import { defineConfig } from "nukadoko"`.

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
    ]);

    expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(true);
    const configContent = await readFile(path.join(rootDir, "nukadoko.config.ts"), "utf8");
    expect(configContent).toContain('from "nukadoko"');
    expect(configContent).toContain("defineConfig");

    expect(existsSync(path.join(rootDir, "features", "steps"))).toBe(true);

    const gitignore = await readFile(path.join(rootDir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".nukadoko/");
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
    // ("features") — this task's spec: "self-check がそのディレクトリを見る".
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
