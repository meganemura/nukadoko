import { existsSync, readFileSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  latestRunDir,
  latestRunJson,
  removeTempDir,
  stepRecordDir,
  stepRecordIds,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: the program file end to end through `nuka run`, `nuka
// run --concurrency`, `nuka do`, and `nuka check`: the world each starts,
// what run.json and each step record say about it, the env and the base
// URL the steps get, and a program that does not start.

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "localhost", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function stepResult(rootDir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(stepRecordDir(rootDir, id), "record.json"), "utf8")) as Record<string, unknown>;
}

describe("a program nukadoko serves", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("program-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka run starts one world, gives the steps its URL and env, records it, and stops it", async () => {
    const { exitCode, stderr } = await cli(rootDir, ["run"]);

    expect(stripRunProgressLines(stderr)).toBe("");
    expect(stderr).toMatch(/^world default: serve \d+\.\ds, http:\/\/localhost:\d+ {2}\(log \.nukadoko\/runs\/[^/]+\/worlds\/default\/program\.log\)$/m);
    expect(exitCode).toBe(0);
    const run = latestRunJson(rootDir);
    const worldDir = path.join(latestRunDir(rootDir), "worlds", "default");
    const url = run.worlds[0].url as string;
    expect(run.worlds).toEqual([
      {
        name: "default",
        tree: "head",
        url: expect.stringMatching(/^http:\/\/localhost:\d+$/),
        commands: [{ phase: "serve", argv: ["node", "app/server.mjs"] }],
        timings: { serve_ms: expect.any(Number), stop_ms: expect.any(Number) },
        log: "worlds/default/program.log",
        error: null,
        // One request reached the program, whose log carries no trace id.
        program_log: { stamped: 1, lines: 0 },
      },
    ]);
    expect(run.environments).toEqual([expect.objectContaining({ name: "default", base_url: url })]);

    const [askId] = stepRecordIds(rootDir).filter((id) => stepResult(rootDir, id).step === "ask-program");
    const record = stepResult(rootDir, askId!);
    expect(record.world_name).toBe("default");
    expect(record.result).toEqual({
      db: `${worldDir}/db.sqlite3`,
      token: "{{secret.WORLD_TOKEN}}",
      stepDb: `${worldDir}/db.sqlite3`,
      processDb: `${worldDir}/db.sqlite3`,
    });
    expect(readFileSync(path.join(worldDir, "program.log"), "utf8")).toBe("$ node app/server.mjs\nlistening with token {{secret.WORLD_TOKEN}}\n");
    expect(await answers(Number(new URL(url).port))).toBe(false);
    expect(process.env.DB).toBeUndefined();
  });

  it("nuka run --concurrency 2 starts one world in the parent, and every worker sends its requests there", async () => {
    await copyFile(path.join(rootDir, "features", "world.feature"), path.join(rootDir, "features", "world-again.feature"));
    const { exitCode, stderr } = await cli(rootDir, ["run", "--concurrency", "2"]);

    // Each worker names the scenario it starts.
    expect(stripRunProgressLines(stderr).replace(/^scenario start {2}worker \d .*\n/gm, "")).toBe("");
    expect(exitCode).toBe(0);
    const run = latestRunJson(rootDir);
    expect(run.worlds).toHaveLength(1);
    const asks = stepRecordIds(rootDir)
      .map((id) => stepResult(rootDir, id))
      .filter((record) => record.step === "ask-program");
    expect(asks).toHaveLength(2);
    const worldDir = path.join(latestRunDir(rootDir), "worlds", "default");
    for (const record of asks) {
      expect(record.world_name).toBe("default");
      expect(record.result).toMatchObject({ db: `${worldDir}/db.sqlite3`, processDb: `${worldDir}/db.sqlite3` });
    }
  });

  it("starts a world for each environment, each with a directory of its own", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      [
        'import { defineProgram } from "./nukadoko-shim.js";',
        "export default defineProgram({",
        '  serve: { command: "node app/server.mjs", ready: "/whoami" },',
        '  env: { PORT: "{port}", DB: "{dir}/db.sqlite3", TOKEN: "{token}" },',
        '  environments: { other: { env: { DB: "{dir}/other.sqlite3" } } },',
        "});",
        "",
      ].join("\n"),
    );
    const { exitCode } = await cli(rootDir, ["run", "--env", "default", "--env", "other"]);

    expect(exitCode).toBe(0);
    const run = latestRunJson(rootDir);
    expect(run.worlds.map((world: { name: string; log: string }) => [world.name, world.log])).toEqual([
      ["default", "worlds/default/program.log"],
      ["other", "worlds/other/program.log"],
    ]);
    expect(run.worlds[0].url).not.toBe(run.worlds[1].url);
    const dbs = stepRecordIds(rootDir)
      .map((id) => stepResult(rootDir, id))
      .filter((record) => record.step === "ask-program")
      .map((record) => [record.world_name, (record.result as { db: string }).db]);
    const runDir = latestRunDir(rootDir);
    expect(dbs.sort()).toEqual([
      ["default", path.join(runDir, "worlds", "default", "db.sqlite3")],
      ["other", path.join(runDir, "worlds", "other", "other.sqlite3")],
    ]);
  });

  it("fails the run when the program does not start, names why, and runs no scenario", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      'import { defineProgram } from "./nukadoko-shim.js";\nexport default defineProgram({ serve: { command: ["node", "-e", "console.log(\'no database\'); process.exit(4)"] } });\n',
    );
    const { exitCode, stderr } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "failed\tprogram-start-failed\t-\tthe program did not start for world default: serve command node -e 'console.log('\\''no database'\\''); process.exit(4)' exited with code 4 before http://localhost:",
    );
    expect(stderr).toContain("no database\n");
    expect(stepRecordIds(rootDir)).toEqual([]);
    const run = latestRunJson(rootDir);
    expect(run.worlds).toEqual([
      expect.objectContaining({ name: "default", error: expect.stringContaining("exited with code 4"), log: "worlds/default/program.log" }),
    ]);
    expect(run.counts.passed).toBe(0);
  });

  it("nuka do starts the head world for its one step, and stops it after", async () => {
    const { exitCode, stdout, stderr } = await cli(rootDir, ["do", "ask-program", "--args", "{}"]);

    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/^world default: serve \d+\.\ds, http:\/\/localhost:\d+ {2}\(log \.nukadoko\/do\/[^/]+\/world\/program\.log\)\n$/);
    const record = JSON.parse(stdout) as { step_record_id: string; world_name: string; result: { db: string; token: string } };
    const worldDir = path.join(stepRecordDir(rootDir, record.step_record_id), "world");
    expect(record.world_name).toBe("default");
    expect(record.result).toMatchObject({ db: `${worldDir}/db.sqlite3`, token: "{{secret.WORLD_TOKEN}}" });
    expect(existsSync(path.join(worldDir, "program.log"))).toBe(true);
    const port = Number(/localhost:(\d+)/.exec(stderr)![1]);
    expect(await answers(port)).toBe(false);
  });

  it("nuka do writes no step record when the program does not start", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      'import { defineProgram } from "./nukadoko-shim.js";\nexport default defineProgram({ prepare: ["node -e process.exit(5)"], url: "http://a.example" });\n',
    );
    const { exitCode, stdout, stderr } = await cli(rootDir, ["do", "ask-program", "--args", "{}"]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(
      // A finding is one line, so the log's lines are joined with spaces.
      /^failed\tprogram-start-failed\t-\tthe program did not start for world default: prepare command node -e 'process\.exit\(5\)' exited with code 5\. The end of \.nukadoko\/do\/[^/]+\/world\/program\.log: \$ node -e 'process\.exit\(5\)'\n {2}fix: /,
    );
    // The record's directory holds the world's log, and no record.
    const [id] = stepRecordIds(rootDir);
    expect(existsSync(path.join(stepRecordDir(rootDir, id!), "world", "program.log"))).toBe(true);
    expect(existsSync(path.join(stepRecordDir(rootDir, id!), "record.json"))).toBe(false);
  });

  it("nuka check refuses a program file that does not parse, naming the file", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), 'export default { serve: { command: "x" }, url: "http://a.example" };\n');
    const { exitCode, stderr } = await cli(rootDir, ["check"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain(
      `refused\tconfig-invalid\t-\tInvalid program at ${path.join(rootDir, "nukadoko.program.ts")}: url: serve and url are two ways to reach the program`,
    );
  });
});
