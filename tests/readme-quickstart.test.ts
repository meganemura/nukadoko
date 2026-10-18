import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fixture, removeTempDir, repoRoot, testsDir } from "./helpers/fixtures.js";

// Responsibility: README.md's "Beside your unit tests" walkthrough works as
// written. Its commands run in order in a scratch copy of the CLI project it
// describes, its file blocks are written where their first-line comment
// says, and the last command it shows, `npm run test:scenarios`, exits 0.
// The When step's block is exactly what its scaffold command wrote.
// README.ja.md carries the same blocks, so the two cannot drift apart.
//
// `npm install -D nukadoko` is the one line not run: the scratch project
// links this checkout's own build instead, so the test needs no registry
// and checks the code it ships with. The output blocks are copied from a
// real run of the packed tarball and are not compared here: they carry run
// ids and timings.

const execFileAsync = promisify(execFile);

interface Block {
  readonly lang: string;
  readonly body: string;
}

function quickstartBlocks(readme: string): Block[] {
  const start = readme.indexOf("\n## Beside your unit tests\n");
  expect(start).toBeGreaterThan(-1);
  // The section ends at the next heading outside a fence: the run summary
  // it shows has a `## ` line of its own.
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
  const section = readme.slice(start, end);
  return [...section.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map((match) => ({
    lang: match[1]!,
    body: match[2]!,
  }));
}

// A file block names its path on its first line, as a comment in the file's
// own language; `text` blocks are output, not input.
function filePath(block: Block): string | undefined {
  const first = block.body.split("\n")[0]!;
  return /^(?:\/\/|#) ((?:features|src)\/\S+)$/.exec(first)?.[1];
}

const tempRoot = path.join(testsDir, ".tmp-fixtures");
let projectDir: string | undefined;

afterEach(async () => {
  if (projectDir) await removeTempDir(projectDir);
  projectDir = undefined;
});

describe("README.md: Beside your unit tests", () => {
  it("README.ja.md shows the same commands, files, and output", async () => {
    const en = quickstartBlocks(await readFile(path.join(repoRoot, "README.md"), "utf8"));
    const ja = quickstartBlocks(await readFile(path.join(repoRoot, "README.ja.md"), "utf8"));
    expect(en.map((block) => block.lang)).toEqual([
      "sh", "text", "sh", "text", "ts", "sh", "text", "ts", "gherkin", "sh", "text", "text", "text", "yaml",
    ]);
    expect(ja).toEqual(en);
  });

  it("runs green in a scratch project, command by command", async () => {
    const blocks = quickstartBlocks(await readFile(path.join(repoRoot, "README.md"), "utf8"));
    await mkdir(tempRoot, { recursive: true });
    projectDir = await mkdtemp(path.join(tempRoot, "quickstart-"));
    await cp(fixture("quickstart-project"), projectDir, { recursive: true });
    const bin = path.join(projectDir, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await symlink(repoRoot, path.join(projectDir, "node_modules", "nukadoko"), "dir");
    const nuka = path.join(bin, "nuka");
    await writeFile(nuka, `#!/bin/sh\nexec "${process.execPath}" "${path.join(repoRoot, "dist", "cli.js")}" "$@"\n`);
    await chmod(nuka, 0o755);
    // Without GITHUB_STEP_SUMMARY: under GitHub Actions, the run would
    // otherwise append this scratch project's summary to the job's own.
    const { GITHUB_STEP_SUMMARY: _summary, ...inherited } = process.env;
    const env = { ...inherited, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };

    const ran: string[] = [];
    // A file block the scaffold already wrote as shown, path comment aside:
    // the walkthrough promises neither step needs an edit.
    const unedited: string[] = [];
    for (const block of blocks) {
      const target = filePath(block);
      if (target !== undefined) {
        const written = await readFile(path.join(projectDir, target), "utf8").catch(() => undefined);
        if (written === block.body.slice(block.body.indexOf("\n") + 1)) unedited.push(target);
        await mkdir(path.dirname(path.join(projectDir, target)), { recursive: true });
        await writeFile(path.join(projectDir, target), block.body);
        continue;
      }
      if (block.lang !== "sh") continue;
      for (const line of block.body.split("\n").filter((text) => text.trim() !== "")) {
        if (line === "npm install -D nukadoko") continue;
        ran.push(line);
        try {
          await execFileAsync("sh", ["-c", line], { cwd: projectDir, env });
        } catch (error) {
          const { stdout, stderr } = error as { stdout?: string; stderr?: string };
          throw new Error(`\`${line}\` failed\n${stdout ?? ""}${stderr ?? ""}`);
        }
      }
    }
    expect(ran.at(-1)).toBe("npm run test:scenarios");
    expect(unedited).toEqual(["features/steps/run-greet.ts", "features/steps/output-says.ts"]);
  }, 120_000);
});
