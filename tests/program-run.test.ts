import { execFile } from "node:child_process";
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
  repoRoot,
  sourceNodeArgs,
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

/** The CLI in a process of its own, for what only the real
 * `process.stderr` shows: in process, `stderr` is a capture sink. */
function spawnedCli(rootDir: string, args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), ...args], { cwd: rootDir, timeout: 60_000 }, (error, _stdout, stderr) => {
      resolve({ exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stderr });
    });
  });
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
        program_log: { stamped: 1, lines: 0, late: 0, tagged: 0 },
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
    // The terminal and the summary name the log from the project root.
    const log = `${run.run_dir}/worlds/default/program.log`;
    expect(stderr).toContain(`. The end of ${log}: $ node -e`);
    expect(readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8")).toContain(
      `No scenario failed, but the run did. The program did not start for world default (\`program-start-failed\`), so no scenario ran there; its log is \`${log}\`.`,
    );
    expect(run.worlds).toEqual([
      expect.objectContaining({ name: "default", error: expect.stringContaining("exited with code 4"), log: "worlds/default/program.log" }),
    ]);
    expect(run.counts.passed).toBe(0);
  });

  it("stops a build that does not finish within its timeout_ms, says so when it starts and when it stops, and runs no scenario", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      [
        'import { defineProgram } from "./nukadoko-shim.js";',
        "export default defineProgram({",
        '  build: [{ command: ["node", "-e", "console.log(\'building\'); setInterval(() => {}, 1000)"], timeout_ms: 500 }],',
        '  serve: { command: "node app/server.mjs", ready: "/whoami" },',
        '  env: { PORT: "{port}" },',
        "});",
        "",
      ].join("\n"),
    );
    const startedAt = Date.now();
    const { exitCode, stderr } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(1);
    // The default limit is 600 s; this one stops in well under a minute.
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    const run = latestRunJson(rootDir);
    expect(stderr).toContain("world default: build started: node -e 'console.log('\\''building'\\''); setInterval(() => {}, 1000)'\n");
    expect(stderr).toContain(
      "failed\tprogram-start-failed\t-\tthe program did not start for world default: build command node -e 'console.log('\\''building'\\''); setInterval(() => {}, 1000)' " +
        `did not finish within 500 ms (timeout_ms). The end of ${run.run_dir}/worlds/default/program.log: `,
    );
    expect(stderr).not.toContain("serve started");
    expect(stepRecordIds(rootDir)).toEqual([]);
  });

  it("shows what setup prints once each, redacted, on the terminal and in the log", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      [
        'import { defineProgram } from "./nukadoko-shim.js";',
        "export default defineProgram({",
        '  serve: { command: "node app/server.mjs", ready: "/whoami" },',
        '  env: { PORT: "{port}", DB: "{dir}/db.sqlite3", TOKEN: "{token}", ADMIN_PASSWORD: "{token}" },',
        "  setup(world) {",
        "    console.log(`seeding admin with ${world.env.ADMIN_PASSWORD}`);",
        "    process.stderr.write(`and with ${world.env.ADMIN_PASSWORD} again\\n`);",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = await spawnedCli(rootDir, ["run", "--no-check"]);

    expect(exitCode, stderr).toBe(0);
    const lines = stderr.split("\n");
    expect(lines.filter((line) => line.startsWith("seeding admin"))).toEqual(["seeding admin with {{secret.WORLD_TOKEN}}"]);
    expect(lines.filter((line) => line.startsWith("and with"))).toEqual(["and with {{secret.WORLD_TOKEN}} again"]);
    expect(lines.filter((line) => line.startsWith("world default: setup"))).toEqual(["world default: setup started"]);
    expect(stderr).not.toMatch(/[0-9a-f]{32}/);
    const log = readFileSync(path.join(latestRunDir(rootDir), "worlds", "default", "program.log"), "utf8");
    expect(log).toContain("# setup\nseeding admin with {{secret.WORLD_TOKEN}}\nand with {{secret.WORLD_TOKEN}} again\n");
  });

  it("imports the step files before the world's env is set, at --concurrency 1 and 2 alike, and gives it to the step when it runs", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      'import { defineProgram } from "./nukadoko-shim.js";\nexport default defineProgram({ env: { IMPORT_MARK: "from-the-world" } });\n',
    );
    await writeFile(
      path.join(rootDir, "features", "steps", "read-at-import.ts"),
      [
        'import { z } from "zod";',
        'import { defineStep } from "../../nukadoko-shim.js";',
        "",
        "// What IMPORT_MARK held when this module loaded, and when the step runs.",
        'const atImport = process.env.IMPORT_MARK ?? "unset";',
        "export default defineStep({",
        '  pattern: "the step returns what it read at import",',
        '  description: "IMPORT_MARK at import and at step time",',
        "  args: z.object({}),",
        "  returns: z.object({ atImport: z.string(), atStep: z.string() }),",
        "  mutates: false,",
        "  async run() {",
        '    return { atImport, atStep: process.env.IMPORT_MARK ?? "unset" };',
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(rootDir, "features", "world.feature"), "Feature: A\n\n  Scenario: reads at import\n    When the step returns what it read at import\n");
    await copyFile(path.join(rootDir, "features", "world.feature"), path.join(rootDir, "features", "world-again.feature"));

    for (const concurrency of ["1", "2"]) {
      const { exitCode, stderr } = await cli(rootDir, ["run", "--no-check", "--concurrency", concurrency]);
      expect(exitCode, stderr).toBe(0);
      const results = stepRecordIds(rootDir)
        .map((id) => stepResult(rootDir, id))
        .filter((record) => (record.run_id as string) === latestRunJson(rootDir).run_id)
        .map((record) => record.result);
      expect(results, `--concurrency ${concurrency}`).toEqual([
        { atImport: "unset", atStep: "from-the-world" },
        { atImport: "unset", atStep: "from-the-world" },
      ]);
    }
  });

  it("names the log from the project root when the program exits during the pass", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      [
        'import { defineProgram } from "./nukadoko-shim.js";',
        "// Answers the ready check, then exits.",
        "export default defineProgram({",
        '  serve: { command: ["node", "-e", "require(\'http\').createServer((q, s) => { s.end(\'{}\'); setTimeout(() => process.exit(3), 20); }).listen(process.env.PORT)"] },',
        '  env: { PORT: "{port}" },',
        "});",
        "",
      ].join("\n"),
    );
    const { stderr } = await cli(rootDir, ["run"]);

    const run = latestRunJson(rootDir);
    expect(stderr).toContain(
      `warning\tprogram-exited\t-\tworld default: the program exited with code 3 during the pass; see ${run.run_dir}/worlds/default/program.log\n`,
    );
  });

  it("nuka do starts the head world for its one step, and stops it after", async () => {
    const { exitCode, stdout, stderr } = await cli(rootDir, ["do", "ask-program", "--args", "{}"]);

    expect(exitCode).toBe(0);
    // One line when serve starts, and the ready line.
    expect(stderr).toMatch(
      /^world default: serve started: node app\/server\.mjs, waiting for http:\/\/localhost:(\d+)\/whoami\nworld default: serve \d+\.\ds, http:\/\/localhost:\1 {2}\(log \.nukadoko\/do\/[^/]+\/world\/program\.log\)\n$/,
    );
    const record = JSON.parse(stdout) as { step_record_id: string; world_name: string; result: { db: string; token: string } };
    const worldDir = path.join(stepRecordDir(rootDir, record.step_record_id), "world");
    expect(record.world_name).toBe("default");
    expect(record.result).toMatchObject({ db: `${worldDir}/db.sqlite3`, token: "{{secret.WORLD_TOKEN}}" });
    expect(existsSync(path.join(worldDir, "program.log"))).toBe(true);
    const port = Number(/localhost:(\d+)/.exec(stderr)![1]);
    expect(await answers(port)).toBe(false);
  });

  it("records a step's own write in the world's directory, and leaves the program's writes there to its log", async () => {
    await writeFile(
      path.join(rootDir, "features", "write.feature"),
      "Feature: Writes beside the database\n\n  Scenario: two writers\n    When the step and the program each write a file beside the database\n",
    );
    const filesOf = (record: Record<string, unknown>): unknown =>
      (record.observed as { files: { path: string; change: string }[] | null }).files?.map((file) => [file.path, file.change]);

    expect((await cli(rootDir, ["run", "features/write.feature"])).exitCode).toBe(0);
    const worldDir = path.join(latestRunDir(rootDir), "worlds", "default");
    const [id] = stepRecordIds(rootDir);
    expect(filesOf(stepResult(rootDir, id!))).toEqual([[path.join(worldDir, "step-wrote.txt"), "added"]]);
    expect(existsSync(path.join(worldDir, "program-wrote.txt"))).toBe(true);

    const done = await cli(rootDir, ["do", "write-beside-database", "--args", "{}"]);
    expect(done.exitCode).toBe(0);
    const record = JSON.parse(done.stdout) as Record<string, unknown> & { step_record_id: string };
    const doWorldDir = path.join(stepRecordDir(rootDir, record.step_record_id), "world");
    expect(filesOf(record)).toEqual([[path.join(doWorldDir, "step-wrote.txt"), "added"]]);
    expect(existsSync(path.join(doWorldDir, "program-wrote.txt"))).toBe(true);
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
      /^world default: prepare started: node -e 'process\.exit\(5\)'\nfailed\tprogram-start-failed\t-\tthe program did not start for world default: prepare command node -e 'process\.exit\(5\)' exited with code 5\. The end of \.nukadoko\/do\/[^/]+\/world\/program\.log: \$ node -e 'process\.exit\(5\)'\n {2}fix: /,
    );
    // The record's directory holds the world's log, and no record.
    const [id] = stepRecordIds(rootDir);
    expect(existsSync(path.join(stepRecordDir(rootDir, id!), "world", "program.log"))).toBe(true);
    expect(existsSync(path.join(stepRecordDir(rootDir, id!), "record.json"))).toBe(false);
  });

  it("refuses a placeholder a world has no value for before any command runs, in check, run, run --no-check, and do", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      [
        'import { defineProgram } from "./nukadoko-shim.js";',
        "export default defineProgram({",
        '  build: [["node", "-e", "require(\'fs\').writeFileSync(\'build-ran\', \'\')"]],',
        '  prepare: ["echo {port}"],',
        '  url: "http://127.0.0.1:9",',
        '  environments: { local: { serve: { command: "node app/server.mjs" }, env: { PORT: "{port}" } } },',
        "});",
        "",
      ].join("\n"),
    );
    const gap = "world default: prepare[0] names {port}, which has no value here: this world does not serve";
    const fix = "  fix: Remove {port} from prepare[0] of nukadoko.program.ts, or give world default serve.\n";

    const check = await cli(rootDir, ["check"]);
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain(`error\tprogram-placeholder-unfilled\tnukadoko.program.ts\t${gap}\n${fix}`);
    expect(check.stdout).not.toContain("world local");

    for (const args of [["run", "--no-check"], ["do", "ask-program", "--args", "{}"]]) {
      const refused = await cli(rootDir, args);
      expect(refused.exitCode, args.join(" ")).toBe(2);
      expect(refused.stderr).toBe(`refused\tprogram-placeholder-unfilled\t-\t${gap}; nothing ran\n${fix}`);
    }
    expect((await cli(rootDir, ["run"])).stderr).toContain("program-placeholder-unfilled");
    expect(existsSync(path.join(rootDir, "build-ran"))).toBe(false);
    // nuka check reports every world the file can start, so the gap stops a
    // checked run of any environment; a run refuses only for the worlds it
    // starts, and the world that serves has every value.
    expect((await cli(rootDir, ["run", "--env", "local"])).exitCode).toBe(2);
    const local = await cli(rootDir, ["run", "--env", "local", "--no-check"]);
    expect(local.stderr).toMatch(/^world local: build \S+, prepare \S+, serve \S+, http:\/\/localhost:\d+ /m);
  });

  it("nuka check refuses a program file that does not parse, naming the file", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), 'export default { serve: { command: "x" }, url: "http://a.example" };\n');
    const { exitCode, stderr } = await cli(rootDir, ["check"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain(
      `refused\tconfig-invalid\t-\tInvalid program at ${path.join(rootDir, "nukadoko.program.ts")}: url: serve and url are two ways to reach the program`,
    );
  });

  it.each([
    ["serve: { command: \"node app/server.mjs\", ready: \"//example.com/up\" }", "serve.ready: must be a path on the world's own server"],
    ["url: \"localhost:4123\"", 'url: must be an http: or https: URL, such as "http://localhost:3000"'],
    ["url: \"http://user:hunter2@127.0.0.1:1\"", "url: must not hold a user or a password"],
  ])("nuka check and nuka run refuse %s before anything runs", async (field, reason) => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), `export default { ${field} };\n`);
    for (const args of [["check"], ["run", "--no-check"]]) {
      const { exitCode, stderr } = await cli(rootDir, args);
      expect(exitCode).toBe(2);
      expect(stderr).toContain(`refused\tconfig-invalid\t-\tInvalid program at ${path.join(rootDir, "nukadoko.program.ts")}: ${reason}`);
      expect(stderr).not.toContain("hunter2");
    }
    expect(stepRecordIds(rootDir)).toEqual([]);
  });
});
