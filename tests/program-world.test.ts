import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layerProgram, programSchema, type ProgramInput } from "../src/config/program-schema.js";
import { createWorldStarter, type StartedWorld } from "../src/program/world.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: src/program/world.ts against real processes: a program
// nukadoko builds, prepares, serves on a port of its own, and stops, the
// log it writes, the record it gives, and each way a world fails to start.

// A server that answers with what its process got, and says its token on
// stdout so the log's redaction is visible.
const SERVER = [
  'import { createServer } from "node:http";',
  "console.log(`listening with token ${process.env.TOKEN}`);",
  "createServer((req, res) => {",
  '  res.writeHead(req.url === "/fail" ? 500 : 200, { "content-type": "application/json" });',
  "  res.end(JSON.stringify({ path: req.url, db: process.env.DB, token: process.env.TOKEN }));",
  "}).listen(Number(process.env.PORT));",
  "",
].join("\n");

let rootDir: string;
let runDir: string;
const started: StartedWorld[] = [];

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), "nukadoko-world-"));
  runDir = path.join(rootDir, ".nukadoko", "runs", "r1");
  writeFileSync(path.join(rootDir, "server.mjs"), SERVER);
});

afterEach(async () => {
  for (const world of started.splice(0)) await world.stop();
  rmSync(rootDir, { recursive: true, force: true });
});

function starter(progress = createCaptureSink()) {
  return createWorldStarter({
    rootDir,
    worldDir: (name) => path.join(runDir, "worlds", name),
    recordPath: (absolutePath) => path.relative(runDir, absolutePath).split(path.sep).join("/"),
    progress,
  });
}

function recipe(input: ProgramInput, environment?: string) {
  const program = programSchema.parse(input);
  return layerProgram(program, environment === undefined ? undefined : program.environments?.[environment]);
}

async function startOk(world: Awaited<ReturnType<ReturnType<typeof starter>["start"]>>): Promise<StartedWorld> {
  if (!world.ok) throw new Error(world.message);
  started.push(world);
  return world;
}

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

const SERVE = { serve: { command: "node server.mjs", ready: "/" }, env: { PORT: "{port}", DB: "{dir}/db.sqlite3", TOKEN: "{token}" } } as const;

describe("a world nukadoko serves", () => {
  it("starts the program on its own port with the world's env, writes a redacted log, and stops it", async () => {
    const progress = createCaptureSink();
    const world = await startOk(await starter(progress).start("default", recipe(SERVE), []));
    const dir = path.join(runDir, "worlds", "default");

    expect(world.view.url).toMatch(/^http:\/\/localhost:\d+$/);
    const port = Number(new URL(world.view.url!).port);
    expect(world.view.env).toEqual({ PORT: String(port), DB: `${dir}/db.sqlite3`, TOKEN: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(world.view.secrets).toEqual([{ name: "WORLD_TOKEN", value: world.view.env.TOKEN }]);
    expect(world.view.log).toBe(path.join(dir, "program.log"));
    expect(await (await fetch(`${world.view.url}/hello`)).json()).toEqual({ path: "/hello", db: `${dir}/db.sqlite3`, token: world.view.env.TOKEN });
    expect(progress.text()).toMatch(
      new RegExp(`^world default: serve \\d+\\.\\ds, http://localhost:${port} {2}\\(log ${path.relative(rootDir, dir).split(path.sep).join("\\/").replaceAll(".", "\\.")}/program\\.log\\)\\n$`),
    );

    expect(await world.stop()).toEqual({ exitedEarly: null, late: new Map() });
    expect(await answers(port)).toBe(false);
    expect(readFileSync(path.join(dir, "program.log"), "utf8")).toBe("$ node server.mjs\nlistening with token {{secret.WORLD_TOKEN}}\n");
    expect(world.record()).toEqual({
      name: "default",
      tree: "head",
      url: `http://localhost:${port}`,
      commands: [{ phase: "serve", argv: ["node", "server.mjs"] }],
      timings: { serve_ms: expect.any(Number), stop_ms: expect.any(Number) },
      log: "worlds/default/program.log",
      error: null,
    });
  });

  it("builds once for every world of the tree, and prepares each world with its own env", async () => {
    writeFileSync(path.join(rootDir, "count.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], "x");\n');
    const program: ProgramInput = {
      ...SERVE,
      build: [["node", "count.mjs", "{root}/builds"]],
      prepare: [["node", "-e", "require('node:fs').writeFileSync(process.env.DB, process.env.PORT)"]],
    };
    const shared = starter();
    const one = await startOk(await shared.start("one", recipe(program), []));
    const two = await startOk(await shared.start("two", recipe(program), []));

    expect(readFileSync(path.join(rootDir, "builds"), "utf8")).toBe("x");
    expect(readFileSync(path.join(runDir, "worlds", "two", "db.sqlite3"), "utf8")).toBe(two.view.env.PORT);
    expect(one.view.url).not.toBe(two.view.url);
    expect(one.record().commands.map((command) => command.phase)).toEqual(["build", "prepare", "serve"]);
    expect(two.record().commands.map((command) => command.phase)).toEqual(["prepare", "serve"]);
    expect(readFileSync(path.join(runDir, "worlds", "two", "program.log"), "utf8")).toContain("# build: the same commands already ran for world one\n");
  });

  it("stops the program a shell started, so nothing of the world keeps its port", async () => {
    if (process.platform === "win32") return;
    const world = await startOk(await starter().start("default", recipe({ ...SERVE, serve: { command: ["sh", "-c", "node server.mjs"] } }), []));
    const port = Number(new URL(world.view.url!).port);
    await world.stop();
    expect(await answers(port)).toBe(false);
  });

  it("says the program exited during the pass when it is gone at stop", async () => {
    writeFileSync(path.join(rootDir, "brief.mjs"), `${SERVER}setTimeout(() => process.exit(7), 300);\n`);
    const world = await startOk(await starter().start("default", recipe({ ...SERVE, serve: { command: "node brief.mjs" } }), []));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await world.stop()).exitedEarly).toBe("the program exited with code 7 during the pass; see worlds/default/program.log");
  });
});

describe("a world that does not start", () => {
  it("fails at a prepare command that exits non-zero, with the end of the log, and runs nothing after it", async () => {
    writeFileSync(path.join(rootDir, "migrate.mjs"), "console.log(`migrating ${process.env.TOKEN}`);\nprocess.exit(3);\n");
    const world = await starter().start("default", recipe({ ...SERVE, prepare: ["node migrate.mjs"] }), []);
    expect(world.ok).toBe(false);
    if (world.ok) return;
    expect(world.message).toBe(
      "the program did not start for world default: prepare command node migrate.mjs exited with code 3. " +
        "The end of worlds/default/program.log:\n$ node migrate.mjs\nmigrating {{secret.WORLD_TOKEN}}",
    );
    expect(world.record()).toMatchObject({ url: expect.stringMatching(/^http:\/\/localhost:\d+$/), commands: [{ phase: "prepare" }], error: expect.stringContaining("exited with code 3") });
  });

  it("fails when the server exits before its ready path answers", async () => {
    const world = await starter().start("default", recipe({ ...SERVE, serve: { command: ["node", "-e", "process.exit(2)"] } }), []);
    expect(world.ok).toBe(false);
    if (world.ok) return;
    expect(world.message).toMatch(/^the program did not start for world default: serve command node -e 'process\.exit\(2\)' exited with code 2 before http:\/\/localhost:\d+\/ answered\./);
  });

  it("fails when the ready path does not answer 2xx in time, and stops the server it started", async () => {
    writeFileSync(path.join(rootDir, "pid.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("pid", String(process.pid));\n${SERVER}`);
    const world = await starter().start("default", recipe({ ...SERVE, serve: { command: "node pid.mjs", ready: "/fail", timeout_ms: 800 } }), []);
    expect(world.ok).toBe(false);
    if (world.ok) return;
    expect(world.message).toMatch(/serve command node pid\.mjs did not answer http:\/\/localhost:\d+\/fail with a 2xx status within 800 ms\./);
    const pid = Number(readFileSync(path.join(rootDir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("refuses a fixed port something already answers on", async () => {
    const holder = net.createServer().listen(0);
    await new Promise((resolve) => holder.once("listening", resolve));
    const port = (holder.address() as net.AddressInfo).port;
    try {
      const world = await starter().start("default", recipe({ ...SERVE, serve: { command: "node server.mjs", port } }), []);
      expect(world.ok).toBe(false);
      if (world.ok) return;
      expect(world.message).toBe(
        `the program did not start for world default: something already answers on port ${port}, so every request would reach a server nukadoko did not start; stop it, or write port: "auto"`,
      );
    } finally {
      holder.close();
    }
  });

  it("refuses a placeholder the world has no value for, by name", async () => {
    const build = await starter().start("default", recipe({ build: ["make PORT={port}"] }), []);
    expect(build.ok ? null : build.message).toBe(
      "the program did not start for world default: build[0] names {port}, which has no value here: build runs once per tree, before any world exists",
    );
    const env = await starter().start("default", recipe({ url: "http://a.example", env: { PORT: "{port}" } }), []);
    expect(env.ok ? null : env.message).toBe("the program did not start for world default: env.PORT names {port}, which has no value here: this world does not serve");
  });

  it("fails when setup throws, after stopping the server", async () => {
    let port = 0;
    const world = await starter().start(
      "default",
      recipe({
        ...SERVE,
        setup: (world) => {
          port = world.port!;
          throw new Error("no admin user");
        },
      }),
      [],
    );
    expect(world.ok ? null : world.message).toBe("the program did not start for world default: setup threw: no admin user. The end of worlds/default/program.log:\n$ node server.mjs\nlistening with token {{secret.WORLD_TOKEN}}");
    expect(await answers(port)).toBe(false);
  });
});

describe("a world nukadoko does not serve", () => {
  it("reaches a url, a function of the world, and starts nothing", async () => {
    const progress = createCaptureSink();
    const world = await startOk(
      await starter(progress).start("pr-12", recipe({ environments: { "pr-12": { url: ({ name }) => `https://${name}.preview.example` } } }, "pr-12"), []),
    );
    expect(world.view).toEqual({
      name: "pr-12",
      url: "https://pr-12.preview.example",
      env: {},
      secrets: [{ name: "WORLD_TOKEN", value: expect.any(String) }],
      log: null,
      dir: path.join(runDir, "worlds", "pr-12"),
      tracePrefix: expect.stringMatching(/^[0-9a-f]{8}$/),
    });
    expect(progress.text()).toBe("");
    await world.stop();
    expect(world.record()).toEqual({
      name: "pr-12",
      tree: "head",
      url: "https://pr-12.preview.example",
      commands: [],
      timings: { stop_ms: expect.any(Number) },
      log: null,
      error: null,
      // nukadoko does not read the log of a program it did not start.
      program_log: null,
    });
    expect(existsSync(path.join(runDir, "worlds", "pr-12", "program.log"))).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("a world on Windows", () => {
  it("serves through a .cmd file, and stopping the world ends the server the batch file started", async () => {
    writeFileSync(path.join(rootDir, "serve.cmd"), '@node "%~dp0server.mjs"\r\n');
    const world = await startOk(await starter().start("default", recipe({ ...SERVE, serve: { command: "serve.cmd" } }), []));
    const port = Number(new URL(world.view.url!).port);
    await world.stop();
    expect(await answers(port)).toBe(false);
  });
});
