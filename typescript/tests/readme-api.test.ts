import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpLogLines, latestRunJson, repoRoot, stepRecordDir, withoutCheckNotes } from "./helpers/fixtures.js";

// Responsibility: README.md's two HTTP sections work as written.
//
// "An HTTP API": its program file, its install line, and its two scaffold
// lines, run as written in a project with Playwright after a plain
// `nuka init`, take its feature to green against the program nukadoko
// starts, with the request counted.
//
// "Calling the program with fetch": that section's When step, beside the
// program file the section above shows, compiles under `tsc --strict`,
// with `skipLibCheck: false`, in a project with no Playwright installed.
// The Then step comes from the scaffold command the section names, and
// `nuka run` takes the feature it shows to green. README.ja.md carries the
// same blocks for both.
//
// `src/server.ts` is the one file each section describes without showing,
// so this test writes its own, listening where `PORT` says. The project
// lives under the OS temp directory, as in optional-playwright.test.ts:
// from inside this repository, Node's walk up through ancestor
// node_modules reaches the repository's own playwright, and the section's
// claim is that `fetch` needs nothing installed.

const execFileAsync = promisify(execFile);
const HIDDEN = new Set(["playwright", "playwright-core", ".bin", "nukadoko"]);
const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const HTTP_API = "An HTTP API";
const FETCH = "Calling the program with fetch";
const THEN_SCAFFOLD = 'nuka scaffold message-is --pattern "the message is {text:string}" --then --from get-greeting.message';

interface Block {
  readonly lang: string;
  readonly body: string;
}

function sectionBlocks(readme: string, heading: string): Block[] {
  const start = readme.indexOf(`\n## ${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const body = readme.indexOf("\n", start + 1) + 1;
  let fenced = false;
  let end = readme.length;
  let offset = body;
  for (const line of readme.slice(body).split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced && line.startsWith("## ")) {
      end = offset;
      break;
    }
    offset += line.length + 1;
  }
  return [...readme.slice(start, end).matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map((match) => ({
    lang: match[1]!,
    body: match[2]!,
  }));
}

function filePath(block: Block): string {
  const first = block.body.split("\n")[0]!;
  const target = /^(?:\/\/|#) (\S+)$/.exec(first)?.[1];
  if (target === undefined) throw new Error(`block has no path comment: ${first}`);
  return target;
}

const SERVER = `import { createServer } from "node:http";

createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "").replace(/^\\/greet\\//, ""));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: \`Hello, \${name}!\` }));
}).listen(Number(process.env.PORT));
`;

// skipLibCheck off: the package's own declarations are compiled too, so a
// declaration that only compiles with Playwright installed fails here.
const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      // What `nuka init` adds, so the `.ts` import names scaffold writes check.
      rewriteRelativeImportExtensions: true,
      types: ["node"],
    },
    include: ["nukadoko.config.ts", "nukadoko.program.ts", "src", "features"],
  },
  null,
  2,
)}\n`;

let root: string;
let projectDir: string;
let cli: string;
let blocks: Block[];

async function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // Without GITHUB_STEP_SUMMARY: under GitHub Actions, the run would
  // otherwise append this scratch project's summary to the job's own.
  const { GITHUB_STEP_SUMMARY: _summary, ...env } = process.env;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: projectDir, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code?: number; stdout?: string; stderr?: string };
    return { code: code ?? 1, stdout: stdout ?? "", stderr: stderr ?? "" };
  }
}

const nuka = (args: string[]) => run(process.execPath, [cli, ...args]);
const typecheck = () => run(process.execPath, [tsc, "-p", projectDir]);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nukadoko-readme-api-"));
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
    `${JSON.stringify({ name: "greet-api", private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(path.join(projectDir, "tsconfig.json"), TSCONFIG);
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await writeFile(path.join(projectDir, "src", "server.ts"), SERVER);
  await writeFile(path.join(projectDir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\n\nexport default defineConfig({});\n');
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const [program] = sectionBlocks(readme, HTTP_API);
  blocks = [program!, ...sectionBlocks(readme, FETCH)];
  for (const block of blocks) {
    const target = path.join(projectDir, filePath(block));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, block.body);
  }
  // The Then step: the command the prose names (wrapped across lines there,
  // as Markdown allows), run as it writes it: the prose promises no edit.
  expect(readme.replace(/\s+/g, " ")).toContain(THEN_SCAFFOLD);
  const args = [...THEN_SCAFFOLD.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!).slice(1);
  const scaffold = await nuka(args);
  expect(scaffold.stdout, scaffold.stderr).toBe("features/steps/message-is.ts\n");
  const thenPath = path.join(projectDir, "features", "steps", "message-is.ts");
  expect(await readFile(thenPath, "utf8")).toContain(
    '  claims: [{ actual: "message", compare: "equal", expected: "text" }],\n',
  );
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe(`README.md: ${FETCH}`, () => {
  it("README.ja.md shows the same blocks", async () => {
    const en = sectionBlocks(await readFile(path.join(repoRoot, "README.md"), "utf8"), FETCH);
    const ja = sectionBlocks(await readFile(path.join(repoRoot, "README.ja.md"), "utf8"), FETCH);
    expect(en.map((block) => block.lang)).toEqual(["ts", "gherkin"]);
    expect(en.map(filePath)).toEqual(["features/steps/get-greeting.ts", "features/greet.feature"]);
    expect(ja).toEqual(en);
  });

  it("compiles under tsc --strict, and fails on a fixture name the bag does not have", async () => {
    const stepPath = path.join(projectDir, "features", "steps", "get-greeting.ts");
    const step = await readFile(stepPath, "utf8");
    expect(step).toContain("async run({ baseURL }");

    // The negative control first, so the green compile below is a real check.
    await writeFile(stepPath, step.replaceAll("baseURL", "baseUrl"));
    try {
      const misspelled = await typecheck();
      expect(misspelled.code).not.toBe(0);
      expect(misspelled.stdout).toContain("Property 'baseUrl' does not exist on type 'FixtureBag'");
    } finally {
      await writeFile(stepPath, step);
    }

    const typed = await typecheck();
    expect(typed.stdout).toBe("");
    expect(typed.code).toBe(0);
    const check = await nuka(["check"]);
    expect(withoutCheckNotes(check.stdout + check.stderr)).toBe("");
    expect(check.code).toBe(0);
  }, 120_000);

  it("runs green against the program nukadoko starts, and the fetch call lands in http.jsonl with its response body", async () => {
    const result = await nuka(["run", "--records"]);
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
      status: string;
      steps: Array<{ step_record_id: string }>;
    };
    expect(record.status).toBe("passed");
    const when = JSON.parse(
      await readFile(
        path.join(stepRecordDir(projectDir, record.steps[0]!.step_record_id), "record.json"),
        "utf8",
      ),
    ) as { evidence: { http?: string }; observed: { http: number | null }; world_name: string };
    expect(when.evidence.http).toBe("http.jsonl");
    expect(when.observed.http).toBe(1);
    expect(when.world_name).toBe("default");
    const lines = httpLogLines(projectDir, record.steps[0]!.step_record_id);
    expect(lines.map(({ method, via, status, response_body }) => ({ method, via, status, response_body }))).toEqual([
      { method: "GET", via: "fetch", status: 200, response_body: { text: JSON.stringify({ message: "Hello, Ada!" }), bytes: expect.any(Number) } },
    ]);
  }, 120_000);
});

// The section's `sh` lines, split the way a shell splits these: on spaces,
// with a double-quoted run kept as one word. None of them holds anything else.
function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
}

describe(`README.md: ${HTTP_API}`, () => {
  let apiRoot: string;
  let apiDir: string;
  let apiCli: string;
  let apiBlocks: Block[];
  const nukaIn = (args: string[]) => {
    const { GITHUB_STEP_SUMMARY: _summary, ...env } = process.env;
    return execFileAsync(process.execPath, [apiCli, ...args], { cwd: apiDir, env }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );
  };

  beforeAll(async () => {
    apiRoot = await mkdtemp(path.join(os.tmpdir(), "nukadoko-readme-server-"));
    apiDir = path.join(apiRoot, "project");
    const modules = path.join(apiDir, "node_modules");
    const installed = path.join(modules, "nukadoko");
    await mkdir(installed, { recursive: true });
    await cp(path.join(repoRoot, "package.json"), path.join(installed, "package.json"));
    await cp(path.join(repoRoot, "dist"), path.join(installed, "dist"), { recursive: true });
    // Playwright stays visible here: the section installs it, for `request`.
    for (const name of await readdir(path.join(repoRoot, "node_modules"))) {
      if (name === "nukadoko" || name === ".bin") continue;
      await symlink(path.join(repoRoot, "node_modules", name), path.join(modules, name), "dir");
    }
    apiCli = path.join(installed, "dist", "cli.js");
    await writeFile(path.join(apiDir, "package.json"), `${JSON.stringify({ name: "greet-api", private: true, type: "module" }, null, 2)}\n`);
    await mkdir(path.join(apiDir, "src"), { recursive: true });
    await writeFile(
      path.join(apiDir, "src", "server.ts"),
      'import { createServer } from "node:http";\n' +
        "createServer((req, res) => {\n" +
        '  res.end(`Hello, ${decodeURIComponent((req.url ?? "").replace(/^\\/greet\\//, ""))}!`);\n' +
        "}).listen(Number(process.env.PORT));\n",
    );
    apiBlocks = sectionBlocks(await readFile(path.join(repoRoot, "README.md"), "utf8"), HTTP_API);
  }, 120_000);

  afterAll(async () => {
    await rm(apiRoot, { recursive: true, force: true });
  });

  it("README.ja.md shows the same blocks", async () => {
    const ja = sectionBlocks(await readFile(path.join(repoRoot, "README.ja.md"), "utf8"), HTTP_API);
    expect(apiBlocks.map((block) => block.lang)).toEqual(["ts", "gherkin", "sh"]);
    expect(apiBlocks.slice(0, 2).map(filePath)).toEqual(["nukadoko.program.ts", "features/greet.feature"]);
    expect(ja).toEqual(apiBlocks);
  });

  it("its program file and commands, after nuka init, run the feature green against the program nukadoko starts", async () => {
    const [program, feature, commands] = apiBlocks;
    const [install, ...scaffolds] = commands!.body.trim().split("\n");
    // The pin the section installs is the one this repository tests against.
    const own = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(install).toBe(`npm install -D -E playwright@${own.devDependencies.playwright}`);

    const init = await nukaIn(["init"]);
    expect(init.code, init.stderr).toBe(0);
    await writeFile(path.join(apiDir, filePath(program!)), program!.body);
    await writeFile(path.join(apiDir, filePath(feature!)), feature!.body);
    for (const line of scaffolds) {
      const words = shellWords(line);
      expect(words.slice(0, 3)).toEqual(["npx", "nuka", "scaffold"]);
      const scaffold = await nukaIn(words.slice(2));
      expect(scaffold.code, scaffold.stderr).toBe(0);
    }

    const result = await nukaIn(["run", "--records"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/^world default: serve \d+\.\ds, http:\/\/localhost:\d+ {2}\(log \.nukadoko\/runs\/\S+\/worlds\/default\/program\.log\)$/m);
    expect(latestRunJson(apiDir).worlds).toEqual([
      expect.objectContaining({ name: "default", commands: [{ phase: "serve", argv: ["node", "src/server.ts"] }], error: null }),
    ]);
    const record = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
      status: string;
      steps: Array<{ step_record_id: string }>;
    };
    expect(record.status).toBe("passed");
    const when = JSON.parse(
      await readFile(path.join(stepRecordDir(apiDir, record.steps[0]!.step_record_id), "record.json"), "utf8"),
    ) as { evidence: { http?: string } };
    expect(when.evidence.http).toBe("http.jsonl");
    const lines = (await readFile(path.join(stepRecordDir(apiDir, record.steps[0]!.step_record_id), "http.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { method: string; via: string }))).toMatchObject([{ method: "GET", via: "request" }]);
  }, 120_000);
});
