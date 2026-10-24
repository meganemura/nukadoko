import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpLogLines, repoRoot, stepRecordDir, withoutCheckNotes } from "./helpers/fixtures.js";

// Responsibility: README.md's two HTTP sections work as written.
//
// "A server you start yourself": its config block (the process-scope server fixture and the `StepFixtures`
// augmentation) and its When step compile under `tsc --strict`, with
// `skipLibCheck: false`, in a project with no Playwright installed. The
// Then step comes from the scaffold command the section names, and
// `nuka run` takes the feature it shows to green. README.ja.md carries the same blocks.
//
// "An HTTP API": its `nuka init --server` line and its two scaffold lines,
// run as written in a project with Playwright, write a config holding the
// server fixture it shows, and `nuka run` takes its feature to green with
// the request counted. Only the port differs: a fixed 3000 could already be
// taken on the machine running the test, and runServer refuses a taken
// port.
//
// `src/server.ts` is the one file each section describes without showing,
// so this test writes its own. The project lives under the OS temp
// directory, as in optional-playwright.test.ts: from inside this
// repository, Node's walk up through ancestor node_modules reaches the
// repository's own playwright, and the section's claim is that `fetch`
// needs nothing installed.

const execFileAsync = promisify(execFile);
const HIDDEN = new Set(["playwright", "playwright-core", ".bin", "nukadoko"]);
const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const SELF_STARTED = "A server you start yourself";
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
import type { AddressInfo } from "node:net";

export async function startServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").replace(/^\\/greet\\//, ""));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: \`Hello, \${name}!\` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: \`http://127.0.0.1:\${port}\`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
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
    include: ["nukadoko.config.ts", "src", "features"],
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
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  blocks = sectionBlocks(readme, SELF_STARTED);
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

describe(`README.md: ${SELF_STARTED}`, () => {
  it("README.ja.md shows the same blocks", async () => {
    const en = sectionBlocks(await readFile(path.join(repoRoot, "README.md"), "utf8"), SELF_STARTED);
    const ja = sectionBlocks(await readFile(path.join(repoRoot, "README.ja.md"), "utf8"), SELF_STARTED);
    expect(en.map((block) => block.lang)).toEqual(["ts", "ts", "gherkin"]);
    expect(en.map(filePath)).toEqual(["nukadoko.config.ts", "features/steps/get-greeting.ts", "features/greet.feature"]);
    expect(ja).toEqual(en);
  });

  it("compiles under tsc --strict, and fails without the StepFixtures augmentation", async () => {
    const config = blocks[0]!.body;
    const configPath = path.join(projectDir, "nukadoko.config.ts");
    const augmentation = config.slice(config.indexOf('declare module "nukadoko"'));
    expect(augmentation).toContain("interface StepFixtures");

    // The negative control first, so the green compile below is a real check.
    await writeFile(configPath, config.replace(augmentation, ""));
    try {
      const without = await typecheck();
      expect(without.code).not.toBe(0);
      expect(without.stdout).toContain("Property 'server' does not exist on type 'FixtureBag'");
      // The section's claim: `nuka check` reads the names and needs no types.
      const check = await nuka(["check"]);
      expect(withoutCheckNotes(check.stdout + check.stderr)).toBe("");
      expect(check.code).toBe(0);
    } finally {
      await writeFile(configPath, config);
    }

    const typed = await typecheck();
    expect(typed.stdout).toBe("");
    expect(typed.code).toBe(0);
  }, 120_000);

  it("runs green, and the fetch call lands in http.jsonl with its response body", async () => {
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
    ) as { evidence: { http?: string }; observed: { http: number | null } };
    expect(when.evidence.http).toBe("http.jsonl");
    expect(when.observed.http).toBe(1);
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

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe("README.md: An HTTP API", () => {
  let apiRoot: string;
  let apiDir: string;
  let apiCli: string;
  let apiBlocks: Block[];
  let port: number;
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
    port = await freePort();
    await mkdir(path.join(apiDir, "src"), { recursive: true });
    await writeFile(
      path.join(apiDir, "src", "server.ts"),
      'import { createServer } from "node:http";\n' +
        "createServer((req, res) => {\n" +
        '  res.end(`Hello, ${decodeURIComponent((req.url ?? "").replace(/^\\/greet\\//, ""))}!`);\n' +
        `}).listen(${port}, "127.0.0.1");\n`,
    );
    apiBlocks = sectionBlocks(await readFile(path.join(repoRoot, "README.md"), "utf8"), "An HTTP API");
  }, 120_000);

  afterAll(async () => {
    await rm(apiRoot, { recursive: true, force: true });
  });

  it("README.ja.md shows the same blocks", async () => {
    const ja = sectionBlocks(await readFile(path.join(repoRoot, "README.ja.md"), "utf8"), "An HTTP API");
    expect(apiBlocks.map((block) => block.lang)).toEqual(["sh", "ts", "gherkin", "sh"]);
    expect(ja).toEqual(apiBlocks);
  });

  it("its commands, run as written, write the fixture it shows, and the feature runs green", async () => {
    const [setup, fixture, feature, scaffolds] = apiBlocks;
    const setupLines = setup!.body.trim().split("\n");
    expect(setupLines).toEqual([
      'npx nuka init --server "node src/server.ts" --server-url http://127.0.0.1:3000',
      "npm install -D -E playwright@1.61.1",
    ]);
    // The pin the section installs is the one this repository tests against.
    const own = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(`playwright@${own.devDependencies.playwright}`).toBe(shellWords(setupLines[1]!).at(-1));

    const init = await nukaIn(shellWords(setupLines[0]!.replace(":3000", `:${port}`)).slice(2));
    expect(init.code, init.stderr).toBe(0);
    const config = await readFile(path.join(apiDir, "nukadoko.config.ts"), "utf8");
    const squash = (text: string) => text.replace(/\s+/g, " ").trim();
    const shown = fixture!.body.split("\n").slice(1).join("\n");
    expect(squash(config)).toContain(squash(shown));

    await writeFile(path.join(apiDir, filePath(feature!)), feature!.body);
    for (const line of scaffolds!.body.trim().split("\n")) {
      const words = shellWords(line);
      expect(words.slice(0, 3)).toEqual(["npx", "nuka", "scaffold"]);
      const scaffold = await nukaIn(words.slice(2));
      expect(scaffold.code, scaffold.stderr).toBe(0);
    }

    const result = await nukaIn(["run", "--records"]);
    expect(result.code, result.stderr).toBe(0);
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
