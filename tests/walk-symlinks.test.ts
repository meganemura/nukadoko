import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, repoRoot } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: a monorepo links shared steps and shared features into
// featuresDir. Discovery and the feature walk read what a link points to,
// enter a linked directory once even when a link points back up the tree,
// pass a dangling link on to the import or read that names it, and read a
// feature reached both through a link and directly as one file, in discovery
// and among `nuka run` targets alike.

function stepSource(pattern: string): string {
  return `import { z } from "zod";
import { defineStep } from "../nukadoko-shim.js";

export default defineStep({
  pattern: ${JSON.stringify(pattern)},
  description: ${JSON.stringify(pattern)},
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
`;
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

async function createProject(config = "{}"): Promise<string> {
  const dir = await mkdtemp(path.join(await realpath("/tmp"), "nk-links-"));
  await write(dir, "package.json", `${JSON.stringify({ type: "module" })}\n`);
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(path.join(repoRoot, "node_modules", "zod"), path.join(dir, "node_modules", "zod"), "dir");
  const shimTarget = path.relative(dir, path.join(repoRoot, "src", "index.js")).split(path.sep).join("/");
  await write(dir, "nukadoko-shim.ts", `export * from "${shimTarget}";\n`);
  await write(dir, "nukadoko.config.ts", `import { defineConfig } from "./nukadoko-shim.js";\nexport default defineConfig(${config});\n`);

  await write(dir, path.join("shared-steps", "shared.ts"), stepSource("a shared step runs"));
  await write(
    dir,
    path.join("shared-steps", "group", "grouped.ts"),
    stepSource("a step in a linked directory runs").replace("../nukadoko-shim.js", "../../nukadoko-shim.js"),
  );
  await write(dir, path.join("shared-features", "shared.feature"), "Feature: shared\n\n  Scenario: s\n    Given a line no step binds\n");
  await write(
    dir,
    path.join("features", "a.feature"),
    "Feature: a\n\n  Scenario: s\n    Given a shared step runs\n    And a step in a linked directory runs\n",
  );

  await mkdir(path.join(dir, "features", "steps"), { recursive: true });
  await symlink(path.join("..", "..", "shared-steps", "shared.ts"), path.join(dir, "features", "steps", "shared.ts"));
  await symlink(path.join("..", "..", "shared-steps", "group"), path.join(dir, "features", "steps", "group"), "dir");
  await symlink("..", path.join(dir, "features", "steps", "loop"), "dir");
  await symlink(path.join("..", "shared-features", "shared.feature"), path.join(dir, "features", "linked.feature"));
  return dir;
}

describe("symbolic links under featuresDir", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await createProject();
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function check(): Promise<Array<{ code: string; file?: string; line?: number }>> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    await runCli(["check", "--json"], { rootDir, stdout, stderr });
    expect(stderr.text()).toBe("");
    return (bySeverity(stdout.text()) as { errors: Array<{ code: string; file?: string; line?: number }> }).errors;
  }

  it("binds steps from a linked file and a linked directory, and checks a linked feature", async () => {
    const errors = await check();

    expect(errors.map((entry) => [entry.code, entry.file, entry.line])).toEqual([
      ["undefined-step", "features/linked.feature", 4],
    ]);
  });

  it("lists linked steps once, though a link points back up to featuresDir", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    const { steps } = JSON.parse(stdout.text()) as { steps: Array<{ name: string }> };
    expect(steps.map((step) => step.name).sort()).toEqual(["grouped", "shared"]);
  });

  it("passes a dangling link to the import, which names it", async () => {
    const dangling = path.join(rootDir, "features", "steps", "dangling.ts");
    await symlink(path.join("..", "..", "nowhere.ts"), dangling);
    try {
      const errors = await check();
      expect(errors.filter((entry) => entry.code === "step-file-import-failed").map((entry) => entry.file)).toEqual([
        path.join("features", "steps", "dangling.ts"),
      ]);
    } finally {
      await rm(dangling);
    }
  });

  it("reports a dangling feature link as that feature's parse error", async () => {
    const dangling = path.join(rootDir, "features", "gone.feature");
    await symlink(path.join("..", "nowhere.feature"), dangling);
    try {
      const errors = await check();
      expect(errors.filter((entry) => entry.code === "feature-parse-error").map((entry) => entry.file)).toEqual([
        path.join("features", "gone.feature"),
      ]);
    } finally {
      await rm(dangling);
    }
  });
});

describe("a feature linked into featuresDir and also under additionalFeatureDirs", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await createProject(JSON.stringify({ additionalFeatureDirs: ["shared-features"] }));
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("is checked once, under the path featuresDir reached it by", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    await runCli(["check", "--json"], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
    const { errors } = bySeverity(stdout.text()) as { errors: Array<{ code: string; file?: string; line?: number }> };
    expect(errors.map((entry) => [entry.code, entry.file, entry.line])).toEqual([
      ["undefined-step", "features/linked.feature", 4],
    ]);
  });
});

describe("nuka run with a directory target and a link to it", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await createProject();
    await symlink("features", path.join(rootDir, "alias"), "dir");
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function runFeatures(targets: readonly string[]): Promise<Array<[unknown, unknown]>> {
    const stdout = createCaptureSink();
    await runCli(["run", "--records", "--no-check", ...targets], { rootDir, stdout, stderr: createCaptureSink() });
    return stdout
      .text()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { feature: unknown; status: unknown })
      .map((record) => [record.feature, record.status]);
  }

  it("runs each feature once, under the path the first target reached it by", async () => {
    expect(await runFeatures(["features", "alias"])).toEqual([
      ["features/a.feature", "passed"],
      ["features/linked.feature", "failed"],
    ]);
  });

  it("runs a file named directly and through a linked directory once", async () => {
    expect(await runFeatures(["alias", "features/a.feature"])).toEqual([
      ["alias/a.feature", "passed"],
      ["alias/linked.feature", "failed"],
    ]);
  });
});
