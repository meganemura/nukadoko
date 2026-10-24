import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAYWRIGHT_VERSION } from "../src/context/load-playwright.js";
import { readOwnVersion } from "../src/version.js";
import { repoRoot } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

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
    expect(init.stderr).toBe(
      `next: read ${path.join("node_modules", "nukadoko", "llms.txt")}, written for an agent: the loop, every command, and every finding code\n`,
    );
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
        `ctx.page() in "Given a blank page is open" needs "playwright", and this project has not installed it; ` +
        `nukadoko is tested against playwright@${PLAYWRIGHT_VERSION}` +
        `\n  do: npm install -D -E playwright@${PLAYWRIGHT_VERSION}\n`,
    );
  }, 60_000);

  it("check reports a request step, and --json carries the finding", async () => {
    const check = await nuka(["check", "--json", "features/http.feature"]);
    expect(check.code).toBe(1);
    expect(JSON.parse(check.stdout)).toEqual({
      schema_version: 3,
      nukadoko: readOwnVersion(),
      command: "check",
      verdict: "failed",
      findings: [
        {
          severity: "error",
          code: "playwright-missing",
          message:
            `ctx.request() in "When the URL "http://127.0.0.1:9/" is fetched" needs "playwright", and this project ` +
            `has not installed it; nukadoko is tested against playwright@${PLAYWRIGHT_VERSION}`,
          file: "features/http.feature",
          line: 4,
          step: "fetch-url",
          do: `npm install -D -E playwright@${PLAYWRIGHT_VERSION}`,
        },
        {
          severity: "warning",
          code: "scenario-without-then",
          message:
            'Scenario "fetches" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.',
          file: "features/http.feature",
          line: 3,
          fix: "Add a Then line that binds a claim step (defineStep with claims) and checks the outcome the scenario is for.",
        },
      ],
      fail_on_hits: [],
    });
  }, 60_000);

  it("check with no target reports each Playwright step once and passes over the CLI step", async () => {
    const check = await nuka(["check", "--json"]);
    expect(check.code).toBe(1);
    const report = bySeverity(check.stdout) as { errors: { code: string; step?: string }[] };
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
      `ctx.page() in "Given a blank page is open" needs "playwright", and this project has not installed it; ` +
        `nukadoko is tested against playwright@${PLAYWRIGHT_VERSION}`,
    );
  }, 60_000);

  it("fails a request step at run time the same way", async () => {
    const run = await nuka(["run", "--no-check", "features/http.feature"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`ctx.request() in "When the URL "http://127.0.0.1:9/" is fetched" needs "playwright"`);
  }, 60_000);

  it("check, steps, do, and run --no-check name step files that import playwright themselves with one install line", async () => {
    const steps = path.join(projectDir, "features", "steps");
    const importing = (name: string) =>
      [
        'import { defineStep, z } from "nukadoko";',
        'import { expect } from "playwright/test";',
        "",
        "export default defineStep({",
        `  description: "Check ${name}",`,
        `  pattern: "${name} is checked",`,
        "  args: z.object({}),",
        "  mutates: false,",
        "  run() {",
        "    expect(1).toBe(1);",
        "  },",
        "});",
        "",
      ].join("\n");
    await writeFile(path.join(steps, "expect-a.ts"), importing("a"));
    await writeFile(path.join(steps, "expect-b.ts"), importing("b"));
    try {
      const message =
        'the step file imports "playwright", and this project has not installed it, so the file does not import; ' +
        `nukadoko is tested against playwright@${PLAYWRIGHT_VERSION}`;
      const check = await nuka(["check", "features/cli.feature"]);
      expect(check.code).toBe(1);
      expect(check.stdout).toContain(
        `error\tplaywright-missing\t(2 files)\t${message}\n` +
          "  features/steps/expect-a.ts\n  features/steps/expect-b.ts\n" +
          `  do: npm install -D -E playwright@${PLAYWRIGHT_VERSION}\n`,
      );
      expect(check.stdout).not.toContain("step-file-import-failed");
      expect(check.stdout).not.toContain("Did you mean");
      const json = await nuka(["check", "--json", "features/cli.feature"]);
      const report = bySeverity(json.stdout) as { errors: { code: string; file?: string; message: string }[] };
      expect(report.errors).toEqual([
        { code: "playwright-missing", message, file: "features/steps/expect-a.ts", do: `npm install -D -E playwright@${PLAYWRIGHT_VERSION}` },
        { code: "playwright-missing", message, file: "features/steps/expect-b.ts", do: `npm install -D -E playwright@${PLAYWRIGHT_VERSION}` },
      ]);

      const install = `npm install -D -E playwright@${PLAYWRIGHT_VERSION}`;
      const steps = await nuka(["steps"]);
      expect(steps.code).toBe(1);
      expect(steps.stderr).toBe(
        `error\tplaywright-missing\tfeatures/steps/expect-a.ts\t${message}\n  do: ${install}\n` +
          `error\tplaywright-missing\tfeatures/steps/expect-b.ts\t${message}\n  do: ${install}\n`,
      );
      const stepsJson = await nuka(["steps", "--json"]);
      expect(bySeverity(stepsJson.stdout).errors).toEqual([
        { code: "playwright-missing", file: "features/steps/expect-a.ts", message, do: install },
        { code: "playwright-missing", file: "features/steps/expect-b.ts", message, do: install },
      ]);
      const done = await nuka(["do", "node prints {word:string}", "--args", '{"word":"hi"}']);
      expect(done.code).toBe(2);
      expect(done.stderr).toBe(`refused\tplaywright-missing\t-\tfeatures/steps/expect-a.ts: ${message}\n  fix: Install the package that the message names in the project, at the version that the message names.\n  do: ${install}\n`);
      const run = await nuka(["run", "--no-check", "features/cli.feature"]);
      expect(run.code).toBe(2);
      expect(run.stderr).toBe(`refused\tplaywright-missing\t-\tfeatures/steps/expect-a.ts: ${message}\n  fix: Install the package that the message names in the project, at the version that the message names.\n  do: ${install}\n`);
    } finally {
      await rm(path.join(steps, "expect-a.ts"), { force: true });
      await rm(path.join(steps, "expect-b.ts"), { force: true });
    }
  }, 60_000);

  it("check names a step file that reaches playwright through another file with the same install line", async () => {
    const steps = path.join(projectDir, "features", "steps");
    const support = path.join(projectDir, "support");
    const stepImporting = (name: string, specifier: string) =>
      [
        'import { defineStep, z } from "nukadoko";',
        `import ${JSON.stringify(specifier)};`,
        "",
        "export default defineStep({",
        `  description: "Check ${name}",`,
        `  pattern: "${name} is checked",`,
        "  args: z.object({}),",
        "  mutates: false,",
        "  run() {},",
        "});",
        "",
      ].join("\n");
    await writeFile(path.join(steps, "expect-a.ts"), stepImporting("a", "playwright/test"));
    await writeFile(path.join(steps, "open-page.ts"), stepImporting("open", "./expect-a.ts"));
    await mkdir(support, { recursive: true });
    await writeFile(path.join(support, "pw.ts"), 'export { expect } from "playwright/test";\n');
    await writeFile(path.join(steps, "via-support.ts"), stepImporting("support", "../../support/pw.ts"));
    try {
      const install = `npm install -D -E playwright@${PLAYWRIGHT_VERSION}`;
      const tail = `, and this project has not installed it, so the file does not import; nukadoko is tested against playwright@${PLAYWRIGHT_VERSION}`;
      const json = await nuka(["check", "--json", "features/cli.feature"]);
      expect(json.code).toBe(1);
      expect((bySeverity(json.stdout) as { errors: unknown[] }).errors).toEqual([
        { code: "playwright-missing", message: `the step file imports "playwright"${tail}`, file: "features/steps/expect-a.ts", do: install },
        {
          code: "playwright-missing",
          message: `the step file imports "playwright" through features/steps/expect-a.ts${tail}`,
          file: "features/steps/open-page.ts",
          do: install,
        },
        {
          code: "playwright-missing",
          message: `the step file imports "playwright" through support/pw.ts${tail}`,
          file: "features/steps/via-support.ts",
          do: install,
        },
      ]);
      const check = await nuka(["check", "features/cli.feature"]);
      expect(check.stdout).toContain(
        `error\tplaywright-missing\tfeatures/steps/open-page.ts\tthe step file imports "playwright" through features/steps/expect-a.ts${tail}\n  do: ${install}\n`,
      );
      expect(check.stdout).not.toContain("step-file-import-failed");
      expect(check.stdout).not.toContain("Did you mean");
    } finally {
      await rm(path.join(steps, "expect-a.ts"), { force: true });
      await rm(path.join(steps, "open-page.ts"), { force: true });
      await rm(path.join(steps, "via-support.ts"), { force: true });
      await rm(support, { recursive: true, force: true });
    }
  }, 60_000);

  it("check holds back the undefined lines a playwright-importing step file defines and gives the install line", async () => {
    const steps = path.join(projectDir, "features", "steps");
    await writeFile(
      path.join(steps, "expect-a.ts"),
      [
        'import { defineStep, z } from "nukadoko";',
        'import { expect } from "playwright/test";',
        "",
        "export default defineStep({",
        '  description: "Check a",',
        '  pattern: "a is checked",',
        "  args: z.object({}),",
        "  mutates: false,",
        "  run() {",
        "    expect(1).toBe(1);",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(projectDir, "features", "expect.feature"),
      "Feature: expect\n\n  Scenario: checks\n    Then a is checked\n",
    );
    try {
      const json = await nuka(["check", "--json", "features/expect.feature"]);
      const report = bySeverity(json.stdout) as { errors: { code: string }[]; warnings: unknown[] };
      expect(report.errors.map((issue) => issue.code)).toEqual(["playwright-missing"]);
      expect(report.warnings).toEqual([
        {
          code: "undefined-step-check-suppressed",
          message:
            "Suppressed 1 undefined-step issue because 1 step file could not be read. undefined-step judgment is on hold until the unreadable glue is fixed",
          file: "features/steps/expect-a.ts",
          fix: `Run npm install -D -E playwright@${PLAYWRIGHT_VERSION} (see playwright-missing), then run nuka check again.`,
        },
      ]);
    } finally {
      await rm(path.join(steps, "expect-a.ts"), { force: true });
      await rm(path.join(projectDir, "features", "expect.feature"), { force: true });
    }
  }, 60_000);
});

// `nuka init` puts the step files into the project's own `tsc`, and they
// import `nukadoko`, so the shipped declarations are checked there too. A
// hand-written strict tsconfig does not set `skipLibCheck`, so every
// declaration that names `playwright` has to compile without it, and still
// carry Playwright's own types when it is installed.
describe("the shipped declarations under the project's own tsc", () => {
  let typesRoot: string;

  async function makeProject(
    name: string,
    hidden: ReadonlySet<string>,
    emit: Record<string, unknown> = { noEmit: true },
  ): Promise<string> {
    const dir = path.join(typesRoot, name);
    const modules = path.join(dir, "node_modules");
    const installed = path.join(modules, "nukadoko");
    await mkdir(installed, { recursive: true });
    await cp(path.join(repoRoot, "package.json"), path.join(installed, "package.json"));
    await cp(path.join(repoRoot, "dist"), path.join(installed, "dist"), { recursive: true });
    for (const entry of await readdir(path.join(repoRoot, "node_modules"))) {
      if (hidden.has(entry)) continue;
      await symlink(path.join(repoRoot, "node_modules", entry), path.join(modules, entry), "dir");
    }
    await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ name, private: true, type: "module" }, null, 2)}\n`);
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "index.ts"), "export const greeting = \"hello\";\n");
    await writeFile(
      path.join(dir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: false,
            noUnusedLocals: true,
            noUnusedParameters: true,
            ...emit,
            types: ["node"],
          },
          include: ["src/**/*"],
        },
        null,
        2,
      )}\n`,
    );
    const run = async (args: string[]) => {
      const { GITHUB_STEP_SUMMARY: _summary, ...env } = process.env;
      return execFileAsync(process.execPath, [path.join(installed, "dist", "cli.js"), ...args], { cwd: dir, env });
    };
    const init = await run(["init"]);
    expect(init.stdout).toContain("tsconfig.json");
    await run(["scaffold", "run-greet", "--pattern", "I run greet with {name:string}", "--command"]);
    await run(["scaffold", "output-says", "--pattern", "the output says {text:string}", "--then", "--from", "run-greet.stdout"]);
    // A word's literal needs the JSON type of the value it is compared with, so this one chains it.
    await run(["scaffold", "output-is-empty", "--pattern", "the output is empty", "--then", "--from", "run-greet.stdout"]);
    // A claim step that reads its value through observe, the shape a capture with no --from gets.
    await run(["scaffold", "output-shows", "--pattern", "the output shows {text:string}", "--then"]);
    await run(["scaffold", "plain-stub", "--pattern", "nothing happens yet"]);
    await writeFile(
      path.join(dir, "features", "steps", "page-title.ts"),
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "Read the page title",',
        '  pattern: "the page title is read",',
        "  args: z.object({}),",
        "  async run({ page, request }) {",
        "    await request.get(page.url());",
        "    const title: string = await page.title();",
        '    if (title === "") throw new Error("the page has no title");',
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await mkdir(path.join(dir, "negative"));
    await writeFile(
      path.join(dir, "negative", "not-a-page-method.ts"),
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "Call a method a page does not have",',
        '  pattern: "the page is misused",',
        "  args: z.object({}),",
        "  async run({ page }) {",
        "    await page.notAPageMethod();",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(dir, "tsconfig.negative.json"),
      `${JSON.stringify({ extends: "./tsconfig.json", include: ["negative/**/*"] }, null, 2)}\n`,
    );
    return dir;
  }

  async function tsc(dir: string, project: string): Promise<{ code: number; output: string }> {
    const compiler = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    try {
      const { stdout } = await execFileAsync(process.execPath, [compiler, "-p", project, "--pretty", "false"], { cwd: dir });
      return { code: 0, output: stdout };
    } catch (error) {
      const { code, stdout } = error as { code?: number; stdout?: string };
      return { code: code ?? 1, output: stdout ?? "" };
    }
  }

  let withoutPlaywright: string;
  let withPlaywright: string;
  let emitting: string;

  beforeAll(async () => {
    typesRoot = await mkdtemp(path.join(os.tmpdir(), "nukadoko-declarations-"));
    withoutPlaywright = await makeProject("without-playwright", HIDDEN);
    withPlaywright = await makeProject("with-playwright", new Set([".bin", "nukadoko"]));
    // What `tsc --init`, every library, and every workspace with project
    // references write: a step whose type is inferred from `defineStep` gets
    // its own `.d.ts`, so every name that inferred type reaches has to be
    // one the package entry exports, or tsc stops with TS2742.
    emitting = await makeProject("emitting", HIDDEN, {
      declaration: true,
      declarationMap: true,
      composite: true,
      outDir: "out",
    });
    // `StepRunResult` is the other name `defineStep`'s signature reaches,
    // through `Step.run`, so a project that annotates a step's result by hand
    // has to be able to import it.
    await writeFile(
      path.join(emitting, "src", "step-result.ts"),
      'import type { DefaultReturns, StepRunResult } from "nukadoko";\n\nexport type NoResult = StepRunResult<DefaultReturns>;\n',
    );
  }, 60_000);

  afterAll(async () => {
    if (typesRoot) await rm(typesRoot, { recursive: true, force: true });
  });

  it("compiles init's config, a --command step, a --then --from step, and a page step without playwright", async () => {
    const result = await tsc(withoutPlaywright, "tsconfig.json");
    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  }, 60_000);

  it("compiles the same project with playwright installed", async () => {
    const result = await tsc(withPlaywright, "tsconfig.json");
    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  }, 60_000);

  it("emits declarations for every scaffold shape and init's config under declaration and composite", async () => {
    const result = await tsc(emitting, "tsconfig.json");
    expect(result.output).toBe("");
    expect(result.code).toBe(0);
    const emitted = await readFile(path.join(emitting, "out", "features", "steps", "plain-stub.d.ts"), "utf8");
    expect(emitted).toContain('import("nukadoko").DefaultReturns');
    expect(emitted).not.toContain("node_modules");
    // A claim step's inferred type reaches a name the package entry exports too.
    const claimStep = await readFile(path.join(emitting, "out", "features", "steps", "output-is-empty.d.ts"), "utf8");
    expect(claimStep).toContain('import("nukadoko").ClaimStep');
    expect(claimStep).not.toContain("node_modules");
  }, 60_000);

  it("types page as Playwright's Page when playwright is installed", async () => {
    const result = await tsc(withPlaywright, "tsconfig.negative.json");
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Property 'notAPageMethod' does not exist on type 'Page'.");
  }, 60_000);
});

describe("PLAYWRIGHT_VERSION", () => {
  it("is the devDependency's exact pin and the floor of the peer's caret range", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(pkg.dependencies.playwright).toBeUndefined();
    expect(pkg.peerDependencies.playwright).toBe(`^${PLAYWRIGHT_VERSION}`);
    expect(pkg.peerDependenciesMeta.playwright?.optional).toBe(true);
    expect(pkg.devDependencies.playwright).toBe(PLAYWRIGHT_VERSION);
  });
});
