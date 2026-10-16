import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAYWRIGHT_VERSION } from "../src/context/load-playwright.js";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: `playwright` is an optional peer dependency, so a project
// that never opens a browser runs every everyday command without it, and a
// step that does need it fails with one line naming the install command:
// at `nuka check` (and so before `nuka run` starts), and at run time under
// `--no-check`.
//
// The project lives under the OS temp directory, not under tests/: Node
// resolves a bare specifier by walking up through every ancestor
// node_modules, and from anywhere inside this repository that walk reaches
// the repository's own playwright. The package is a copy of this checkout's
// package.json and dist/ (a symlink would resolve back into the repository
// by its real path), and every other installed package is linked in, so
// only playwright and playwright-core are missing.

const execFileAsync = promisify(execFile);
const HIDDEN = new Set(["playwright", "playwright-core", ".bin", "nukadoko"]);

let root: string;
let projectDir: string;
let cli: string;

async function nuka(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // Without GITHUB_STEP_SUMMARY: under GitHub Actions, the run would
  // otherwise append this scratch project's summary to the job's own.
  const { GITHUB_STEP_SUMMARY: _summary, ...env } = process.env;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd: projectDir, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code?: number; stdout?: string; stderr?: string };
    return { code: code ?? 1, stdout: stdout ?? "", stderr: stderr ?? "" };
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nukadoko-no-playwright-"));
  projectDir = path.join(root, "project");
  const modules = path.join(projectDir, "node_modules");
  const installed = path.join(modules, "nukadoko");
  await mkdir(installed, { recursive: true });
  await cp(path.join(repoRoot, "package.json"), path.join(installed, "package.json"));
  await cp(path.join(repoRoot, "dist"), path.join(installed, "dist"), { recursive: true });
  for (const name of await readdir(path.join(repoRoot, "node_modules"))) {
    if (HIDDEN.has(name)) continue;
    await symlink(path.join(repoRoot, "node_modules", name), path.join(modules, name), "dir");
  }
  cli = path.join(installed, "dist", "cli.js");
  await writeFile(
    path.join(projectDir, "package.json"),
    `${JSON.stringify({ name: "no-browser", private: true, type: "module" }, null, 2)}\n`,
  );
  await mkdir(path.join(projectDir, "features", "steps"), { recursive: true });
  await writeFile(
    path.join(projectDir, "features", "steps", "run-node.ts"),
    [
      'import { defineStep, runCommand, z } from "nukadoko";',
      "",
      "export default defineStep({",
      '  description: "Run node and print a word",',
      '  pattern: "node prints {word:string}",',
      "  args: z.object({ word: z.string() }),",
      "  async run({ scratch }, { word }) {",
      "    const { stdout } = await runCommand(process.execPath, [\"-e\", `console.log(${JSON.stringify(word)})`], {",
      "      cwd: scratch.dir(),",
      "    });",
      '    if (stdout.trim() !== word) throw new Error(`printed "${stdout.trim()}"`);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(projectDir, "features", "steps", "open-page.ts"),
    [
      'import { defineStep, z } from "nukadoko";',
      "",
      "export default defineStep({",
      '  description: "Open a blank page",',
      '  pattern: "a blank page is open",',
      "  args: z.object({}),",
      "  async run({ page }) {",
      '    await page.goto("about:blank");',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(projectDir, "features", "steps", "fetch-url.ts"),
    [
      'import { defineStep, z } from "nukadoko";',
      "",
      "export default defineStep({",
      '  description: "Fetch a URL",',
      '  pattern: "the URL {url:string} is fetched",',
      "  args: z.object({ url: z.string() }),",
      "  async run({ request }, { url }) {",
      "    await request.get(url);",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(projectDir, "features", "cli.feature"),
    "Feature: cli\n\n  Scenario: prints\n    When node prints \"hello\"\n",
  );
  await writeFile(
    path.join(projectDir, "features", "browser.feature"),
    "Feature: browser\n\n  Scenario: opens a page\n    Given a blank page is open\n",
  );
  await writeFile(
    path.join(projectDir, "features", "http.feature"),
    "Feature: http\n\n  Scenario: fetches\n    When the URL \"http://127.0.0.1:9/\" is fetched\n",
  );
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("a project without playwright installed", () => {
  it("cannot resolve playwright from the installed package", async () => {
    const probe = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", 'import("playwright").then(() => console.log("found"), (e) => console.log(e.code))'],
      { cwd: path.join(projectDir, "node_modules", "nukadoko") },
    );
    expect(probe.stdout.trim()).toBe("ERR_MODULE_NOT_FOUND");
  });

  it("runs init, scaffold, check, and a CLI scenario", async () => {
    const init = await nuka(["init"]);
    expect(init.stderr).toBe("");
    expect(init.code).toBe(0);
    const scaffold = await nuka(["scaffold", "unused-step", "--pattern", "nothing happens"]);
    expect(scaffold.code, scaffold.stderr).toBe(0);
    await rm(path.join(projectDir, "features", "steps", "unused-step.ts"));
    const check = await nuka(["check", "features/cli.feature"]);
    expect(check.code, check.stderr).toBe(0);
    const run = await nuka(["run", "features/cli.feature"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("1 scenario: 1 passed, 0 failed");
  }, 60_000);

  it("check reports a page step with the step, the line, and the install command", async () => {
    const check = await nuka(["check", "features/browser.feature"]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain(
      "error\tplaywright-missing\tfeatures/browser.feature:4\t" +
        `ctx.page() in "Given a blank page is open" needs "playwright", and this project has not installed it. ` +
        `Install the version nukadoko is tested against: npm install -D -E playwright@${PLAYWRIGHT_VERSION}`,
    );
  }, 60_000);

  it("check reports a request step, and --json carries the finding", async () => {
    const check = await nuka(["check", "--json", "features/http.feature"]);
    expect(check.code).toBe(1);
    expect(JSON.parse(check.stdout)).toEqual({
      errors: [
        {
          code: "playwright-missing",
          message:
            `ctx.request() in "When the URL "http://127.0.0.1:9/" is fetched" needs "playwright", and this project ` +
            `has not installed it. Install the version nukadoko is tested against: npm install -D -E playwright@${PLAYWRIGHT_VERSION}`,
          file: "features/http.feature",
          line: 4,
          step: "fetch-url",
        },
      ],
      warnings: [],
    });
  }, 60_000);

  it("check with no target reports each Playwright step once and passes over the CLI step", async () => {
    const check = await nuka(["check", "--json"]);
    expect(check.code).toBe(1);
    const report = JSON.parse(check.stdout) as { errors: { code: string; step?: string }[] };
    expect(report.errors.map((issue) => [issue.code, issue.step])).toEqual([
      ["playwright-missing", "open-page"],
      ["playwright-missing", "fetch-url"],
    ]);
  }, 60_000);

  it("run stops at the check before any step runs", async () => {
    const run = await nuka(["run", "features/http.feature"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("error\tplaywright-missing\tfeatures/http.feature:4\t");
    expect(run.stderr).toContain("nuka run did not start");
    expect(run.stderr).not.toContain("step 1/1");
  }, 60_000);

  it("fails a page step at run time with one line naming the step and the install command", async () => {
    const run = await nuka(["run", "--no-check", "features/browser.feature"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(
      `ctx.page() in "Given a blank page is open" needs "playwright", and this project has not installed it. ` +
        `Install the version nukadoko is tested against: npm install -D -E playwright@${PLAYWRIGHT_VERSION}`,
    );
  }, 60_000);

  it("fails a request step at run time the same way", async () => {
    const run = await nuka(["run", "--no-check", "features/http.feature"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`ctx.request() in "When the URL "http://127.0.0.1:9/" is fetched" needs "playwright"`);
  }, 60_000);
});

describe("PLAYWRIGHT_VERSION", () => {
  it("is the exact version package.json pins as the peer and the devDependency", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(pkg.dependencies.playwright).toBeUndefined();
    expect(pkg.peerDependencies.playwright).toBe(PLAYWRIGHT_VERSION);
    expect(pkg.peerDependenciesMeta.playwright?.optional).toBe(true);
    expect(pkg.devDependencies.playwright).toBe(PLAYWRIGHT_VERSION);
  });
});
