import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { isProcessAlive } from "../src/session/lock.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: the two warnings a live session's daemon owes the user
// that `nuka do` and `nuka run` already print: a failed fixture teardown
// (reported on `session stop`) and a failed version probe (reported on each
// `do --session`). The daemon has no terminal, so both travel in its reply
// and the CLI prints them. A real detached daemon is spawned, as in
// tests/live-session.test.ts.

async function createProject(): Promise<string> {
  const dir = await mkdtemp(path.join(await realpath("/tmp"), "nk-"));
  await cp(fixture("live-session-warnings-project"), dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(path.join(repoRoot, "node_modules", "zod"), path.join(dir, "node_modules", "zod"), "dir");
  const relative = path.relative(dir, path.join(repoRoot, "src", "index.js")).split(path.sep).join("/");
  await writeFile(path.join(dir, "nukadoko-shim.ts"), `export * from "${relative}";\n`);
  return dir;
}

describe("live session warnings", () => {
  let rootDir: string;
  let pids: number[];

  beforeEach(async () => {
    rootDir = await createProject();
    pids = [];
  });

  afterEach(async () => {
    for (const pid of pids) {
      if (isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  async function cli(args: string[]) {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(args, { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  async function start(name: string, extra: string[] = []): Promise<void> {
    const started = await cli(["session", "start", name, "--idle-timeout", "120", ...extra]);
    expect(started.exitCode, started.stderr).toBe(0);
    pids.push(Number(started.stdout.trim().split("\t")[1]));
  }

  it("session stop reports a throwing fixture teardown on stderr and still exits 0", async () => {
    await start("hank");
    const done = await cli(["do", "uses-broken-fixture", "--args", "{}", "--session", "hank"]);
    expect(done.exitCode, done.stderr).toBe(0);

    const stopped = await cli(["session", "stop", "hank"]);

    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toBe("");
    expect(stopped.stderr).toBe(
      'Warning: fixture "brokenTeardown" teardown failed: brokenTeardown\'s own teardown exploded on purpose\n',
    );
  });

  it("do --session warns about a failed version probe, as nuka do does", async () => {
    await start("iris", ["--env", "broken"]);

    const done = await cli(["do", "uses-broken-fixture", "--args", "{}", "--session", "iris", "--env", "broken"]);

    expect(done.exitCode, done.stderr).toBe(0);
    expect(JSON.parse(done.stdout)).not.toHaveProperty("target_version");
    expect(done.stderr).toContain('Warning: version probe for environment "broken" failed: probe boom\n');
  });
});
