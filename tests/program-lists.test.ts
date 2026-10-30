import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir, writeUrlProgram } from "./helpers/fixtures.js";

// Responsibility: the program file's `lists` end to end, against
// tests/fixtures/events-project, whose app/list.mjs prints the program's
// routes, flags, and tables after it has asked the running program: each command
// runs once per served world with an events file, after the program
// answers, with the world's env and placeholders, and the world's record
// counts each list's entries. A command that fails or prints what is not
// a list fails no world and no scenario: the record says why the list was
// not read, and a warning names it. A world at a URL, a world with no
// events file, and a program file with no `lists` read none.

const FEATURE = ["Feature: A room", "", "  Scenario: a room is read", '    When the client gets "/rooms/7"', ""].join("\n");

function program(env: string, lists = 'lists: { routes: "node app/list.mjs routes {url}", flags: ["node", "app/list.mjs", "flags", "{url}"] },'): string {
  return [
    'import { defineProgram } from "./nukadoko-shim.js";',
    "",
    "export default defineProgram({",
    '  serve: { command: "node app/server.mjs", ready: "/up" },',
    `  env: { PORT: "{port}", ADMIN_TOKEN: "{token}", JOBS_DIR: "{dir}/jobs"${env} },`,
    `  ${lists}`,
    "});",
    "",
  ].join("\n");
}

const EVENTS = ', EXECUTION_EVENTS: "{events}"';

async function run(rootDir: string): Promise<{ exitCode: number; stderr: string }> {
  const stderr = createCaptureSink();
  const exitCode = await runCli(["run"], { rootDir, stdout: createCaptureSink(), stderr });
  return { exitCode, stderr: stderr.text() };
}

interface Finding {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
}

const listFindings = (rootDir: string): Finding[] =>
  (latestRunJson(rootDir).findings as Finding[])
    .filter((finding) => finding.code === "program-list-unread")
    .map(({ severity, code, message }) => ({ severity, code, message }));

describe("the program file's lists", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    await writeFile(path.join(rootDir, "features", "events.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs each list once the program answers, with the world's placeholders, and counts its entries", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(EVENTS));
    const { exitCode, stderr } = await run(rootDir);

    expect(exitCode).toBe(0);
    const [world] = latestRunJson(rootDir).worlds;
    expect(world.lists).toEqual({ routes: { entries: 7, error: null }, flags: { entries: 2, error: null } });
    expect(world.commands.filter((command: { phase: string }) => command.phase === "lists")).toEqual([
      { phase: "lists", argv: ["node", "app/list.mjs", "routes", world.url] },
      { phase: "lists", argv: ["node", "app/list.mjs", "flags", world.url] },
    ]);
    expect(world.timings.lists_ms).toBeGreaterThanOrEqual(0);
    expect(stderr).toContain(`world default: lists started: node app/list.mjs routes ${world.url}; node app/list.mjs flags ${world.url}`);
    expect(listFindings(rootDir)).toEqual([]);
  });

  it("reads the tables list beside the others, each table once, and refuses one that says two things of a table", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      program(EVENTS, 'lists: { tables: "node app/list.mjs tables {url}", routes: "node app/list.mjs routes {url}" },'),
    );
    expect((await run(rootDir)).exitCode).toBe(0);
    const [world] = latestRunJson(rootDir).worlds;
    // The kinds are read in one order, whatever order the file names them in.
    expect(world.commands.filter((command: { phase: string }) => command.phase === "lists").map((command: { argv: string[] }) => command.argv[2])).toEqual(["routes", "tables"]);
    expect(world.lists).toEqual({ routes: { entries: 7, error: null }, tables: { entries: 5, error: null } });

    await writeFile(
      path.join(rootDir, "app", "two-holdings.mjs"),
      'process.stdout.write(`${JSON.stringify({ table: "events", holds: "bookkeeping" })}\n${JSON.stringify({ table: "rooms" })}\n${JSON.stringify({ table: "events" })}\n`);\n',
    );
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(EVENTS, 'lists: { tables: "node app/two-holdings.mjs" },'));
    expect((await run(rootDir)).exitCode).toBe(0);
    const [refused] = latestRunJson(rootDir).worlds;
    expect(refused.lists).toEqual({
      tables: {
        entries: null,
        error: 'lists.tables command node app/two-holdings.mjs printed a line that is not one entry of the list: line 3 says table "events" holds state, and line 1 says it holds bookkeeping',
      },
    });
    expect(listFindings(rootDir)).toHaveLength(1);
  });

  it("reads no list of a command that fails, and runs the scenarios all the same", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(`${EVENTS}, LIST_MODE: "fail"`));
    const { exitCode, stderr } = await run(rootDir);

    // A list is evidence beside the verdicts: a list that was not read
    // turns no row red.
    expect(exitCode).toBe(0);
    const document = latestRunJson(rootDir);
    expect(document.table.rows.map((row: { verdict: string }) => row.verdict)).toEqual(["held"]);
    const [world] = document.worlds;
    expect(world.lists).toEqual({
      routes: { entries: null, error: `lists.routes command node app/list.mjs routes ${world.url} exited with code 3` },
      flags: { entries: null, error: `lists.flags command node app/list.mjs flags ${world.url} exited with code 3` },
    });
    // With no list read, nothing reads as a route no step requested.
    expect(document).not.toHaveProperty("routes");
    const log = path.join(latestRunDir(rootDir), world.log);
    expect(readFileSync(log, "utf8")).toContain("the routes list is not ready");
    const logPath = path.relative(rootDir, log);
    expect(listFindings(rootDir)).toEqual([
      { severity: "warning", code: "program-list-unread", message: `world default: the routes list was not read: ${world.lists.routes.error}; see ${logPath}` },
      { severity: "warning", code: "program-list-unread", message: `world default: the flags list was not read: ${world.lists.flags.error}; see ${logPath}` },
    ]);
    expect(stderr).toContain("program-list-unread");
  });

  it("reads no list that holds one line it cannot read, and names the line", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(`${EVENTS}, LIST_MODE: "malformed"`, 'lists: { routes: "node app/list.mjs routes {url}" },'));
    const { exitCode } = await run(rootDir);

    expect(exitCode).toBe(0);
    const [world] = latestRunJson(rootDir).worlds;
    expect(world.lists).toEqual({
      routes: {
        entries: null,
        error: `lists.routes command node app/list.mjs routes ${world.url} printed a line that is not one entry of the list: line 2 has the key "path", which a routes line does not have (method, route, handler, or an x_ key of the program's own)`,
      },
    });
    expect(listFindings(rootDir)).toHaveLength(1);
  });

  it("reads no list in a world with no events file, nor in a program file with no lists", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(""));
    expect((await run(rootDir)).exitCode).toBe(0);
    let [world] = latestRunJson(rootDir).worlds;
    expect(world).not.toHaveProperty("lists");
    expect(latestRunJson(rootDir)).not.toHaveProperty("routes");
    expect(world.commands.map((command: { phase: string }) => command.phase)).toEqual(["serve"]);
    expect(world.timings).not.toHaveProperty("lists_ms");

    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(EVENTS, ""));
    expect((await run(rootDir)).exitCode).toBe(0);
    [world] = latestRunJson(rootDir).worlds;
    expect(world).not.toHaveProperty("lists");
    expect(listFindings(rootDir)).toEqual([]);
  });

  describe("in a world at a URL", () => {
    let server: Server;
    let url: string;

    beforeEach(async () => {
      server = createServer((_request, response) => response.end("ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("runs no list command, since nukadoko reads none of the program's lines there", async () => {
      await writeUrlProgram(rootDir, url, 'lists: { routes: "node app/list.mjs routes {url}" }');
      expect((await run(rootDir)).exitCode).toBe(0);

      const [world] = latestRunJson(rootDir).worlds;
      expect(world).not.toHaveProperty("lists");
      expect(latestRunJson(rootDir)).not.toHaveProperty("routes");
      expect(world.commands).toEqual([]);
      expect(listFindings(rootDir)).toEqual([]);
    });
  });
});
