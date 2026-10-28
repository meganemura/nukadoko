import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the progress lines of head's own world name `{dir}` from
// the project root, as every path nukadoko prints does, in `nuka run`,
// `nuka run --concurrency 2`, and `nuka do`. The serve command of
// tests/fixtures/program-project is given `{dir}` in its words, so the
// line that announces it holds the world's directory.

async function withProject<T>(body: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await copyFixtureToTempDir("program-project");
  try {
    const programPath = path.join(rootDir, "nukadoko.program.ts");
    const source = readFileSync(programPath, "utf8");
    const changed = source.replace('command: "node app/server.mjs"', 'command: "node app/server.mjs --data {dir}"');
    expect(changed).not.toBe(source);
    writeFileSync(programPath, changed);
    return await body(rootDir);
  } finally {
    await removeTempDir(rootDir);
  }
}

describe("head's world progress lines name {dir} from the project root", () => {
  const cases: readonly [string, readonly string[], RegExp][] = [
    ["nuka run", ["run"], /^world default: serve started: node app\/server\.mjs --data \.nukadoko\/runs\/run-[^/]+\/worlds\/default, waiting for /m],
    ["nuka run --concurrency 2", ["run", "--concurrency", "2"], /^world default: serve started: node app\/server\.mjs --data \.nukadoko\/runs\/run-[^/]+\/worlds\/default, waiting for /m],
    ["nuka do", ["do", "ask-program", "--args", "{}"], /^world default: serve started: node app\/server\.mjs --data \.nukadoko\/do\/step-[^/]+\/world, waiting for /m],
  ];
  for (const [name, args, line] of cases) {
    it(name, () =>
      withProject(async (rootDir) => {
        const stderr = createCaptureSink();
        const exitCode = await runCli([...args], { rootDir, stdout: createCaptureSink(), stderr });
        expect(exitCode).toBe(0);
        expect(stderr.text()).toMatch(line);
        expect(stderr.text()).not.toContain(rootDir);
      }));
  }
});
