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
    displayPath: (absolutePath) => `project/${path.relative(runDir, absolutePath).split(path.sep).join("/")}`,
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
    expect(world.view.secrets).toEqual([
      { name: "WORLD_TOKEN", value: world.view.env.TOKEN },
      { name: "WORLD_TRACE_IDS", value: world.view.tracePrefix, keep: "trace-ids" },
    ]);
    expect(world.view.log).toBe(path.join(dir, "program.log"));
    expect(await (await fetch(`${world.view.url}/hello`)).json()).toEqual({ path: "/hello", db: `${dir}/db.sqlite3`, token: world.view.env.TOKEN });
    expect(progress.text()).toMatch(
      new RegExp(
        `^world default: serve started: node server\\.mjs, waiting for http://localhost:${port}/\\n` +
          `world default: serve \\d+\\.\\ds, http://localhost:${port} {2}\\(log project/worlds/default/program\\.log\\)\\n$`,
      ),
    );

    expect(await world.stop()).toEqual({ exitedEarly: null, late: new Map(), eventsLate: new Map(), flags: new Map(), recounted: [] });
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
    expect((await world.stop()).exitedEarly).toBe("the program exited with code 7 during the pass; see project/worlds/default/program.log");
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
        "The end of project/worlds/default/program.log:\n$ node migrate.mjs\nmigrating {{secret.WORLD_TOKEN}}",
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
    expect(world.message).toMatch(/serve command node pid\.mjs did not answer http:\/\/localhost:\d+\/fail with a 2xx status within 800 ms \(timeout_ms\); the last answer was 500\./);
    const pid = Number(readFileSync(path.join(rootDir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("does not follow a redirect from the ready path, and names where it pointed", async () => {
    writeFileSync(
      path.join(rootDir, "redirect.mjs"),
      [
        'import { createServer } from "node:http";',
        "createServer((req, res) => {",
        '  if (req.url === "/up") res.writeHead(302, { location: "/login" });',
        "  else res.writeHead(200);",
        "  res.end();",
        "}).listen(Number(process.env.PORT));",
      ].join("\n"),
    );
    const world = await starter().start("default", recipe({ serve: { command: "node redirect.mjs", ready: "/up", timeout_ms: 800 }, env: { PORT: "{port}" } }), []);
    expect(world.ok ? null : world.message).toMatch(
      /did not answer http:\/\/localhost:\d+\/up with a 2xx status within 800 ms \(timeout_ms\); the last answer was 302, a redirect to \/login, which the ready check does not follow\./,
    );
    // The program's log has the one path it was asked, never /login.
    expect(readFileSync(path.join(runDir, "worlds", "default", "program.log"), "utf8")).not.toContain("/login");
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
    const env = await starter().start("default", recipe({ env: { PORT: "{port}" } }), []);
    expect(env.ok ? null : env.message).toBe("the program did not start for world default: env.PORT names {port}, which has no value here: this world has neither serve nor url");
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
    expect(world.ok ? null : world.message).toBe("the program did not start for world default: setup threw: no admin user. The end of project/worlds/default/program.log:\n$ node server.mjs\nlistening with token {{secret.WORLD_TOKEN}}\n# setup");
    expect(await answers(port)).toBe(false);
  });
});

// Whether a process is alive, by pid: `kill(pid, 0)` throws once it is
// gone. A process just killed can stay for a moment until it is reaped,
// so this waits up to 2 seconds for it to go.
async function alive(pid: number): Promise<boolean> {
  const until = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (Date.now() > until) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the limit and the process group of each phase", () => {
  it("stops a build command past its timeout_ms and fails the world, naming the phase and the log", async () => {
    writeFileSync(path.join(rootDir, "hang.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("pid", String(process.pid)); console.log("building"); setInterval(() => {}, 1000);\n');
    const progress = createCaptureSink();
    const begun = Date.now();
    const world = await starter(progress).start("default", recipe({ build: [{ command: "node hang.mjs", timeout_ms: 300 }] }), []);
    expect(world.ok ? null : world.message).toBe(
      "the program did not start for world default: build command node hang.mjs did not finish within 300 ms (timeout_ms). " +
        "The end of project/worlds/default/program.log:\n$ node hang.mjs\nbuilding",
    );
    expect(Date.now() - begun).toBeLessThan(6_000);
    expect(await alive(Number(readFileSync(path.join(rootDir, "pid"), "utf8")))).toBe(false);
    expect(progress.text()).toBe("world default: build started: node hang.mjs\n");
  });

  it.runIf(process.platform !== "win32")("ends a prepare command whose child holds its output, and stops that child", async () => {
    writeFileSync(
      path.join(rootDir, "leave.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
        "child.unref();",
        'writeFileSync("pid", String(child.pid));',
        'console.log("prepared");',
        "",
      ].join("\n"),
    );
    const world = await startOk(await starter().start("default", recipe({ ...SERVE, prepare: ["node leave.mjs"] }), []));
    expect(world.record().commands.map((command) => command.phase)).toEqual(["prepare", "serve"]);
    expect(await alive(Number(readFileSync(path.join(rootDir, "pid"), "utf8")))).toBe(false);
  });

  it("fails a setup and a url function past their timeout_ms", async () => {
    const setup = await starter().start("default", recipe({ ...SERVE, setup: { run: () => new Promise(() => {}), timeout_ms: 200 } }), []);
    expect(setup.ok ? null : setup.message).toMatch(/^the program did not start for world default: setup did not finish within 200 ms \(timeout_ms\)\. The end of /);
    const url = await starter().start("at-url", recipe({ url: { resolve: () => new Promise<string>(() => {}), timeout_ms: 200 } }), []);
    expect(url.ok ? null : url.message).toBe(
      "the program did not start for world at-url: the url function did not finish within 200 ms (timeout_ms). The end of project/worlds/at-url/program.log:\n# the url function was abandoned at its limit (200 ms); it stops only if it honours its signal",
    );
  });

  it("prints a line as each phase starts, and what setup prints, redacted, on the progress sink and in the log", async () => {
    const progress = createCaptureSink();
    const world = await startOk(
      await starter(progress).start(
        "default",
        recipe({
          ...SERVE,
          build: [["node", "-e", "0"]],
          prepare: [["node", "-e", "0"], ["node", "-e", "1", "{token}"]],
          setup: (world) => {
            console.log(`seeding admin with ${world.env.TOKEN}`);
          },
        }),
        [],
      ),
    );
    const token = world.view.env.TOKEN!;
    const lines = progress.text().split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "world default: build started: node -e 0",
      "world default: prepare started: node -e 0; node -e 1 {{secret.WORLD_TOKEN}}",
      `world default: serve started: node server.mjs, waiting for ${world.view.url}/`,
      "world default: setup started",
      "seeding admin with {{secret.WORLD_TOKEN}}",
    ]);
    expect(lines[5]).toMatch(/^world default: build \d+\.\ds, prepare \d+\.\ds, serve \d+\.\ds, setup \d+\.\ds, http:\/\/localhost:\d+ {2}\(log /);
    expect(progress.text()).not.toContain(token);
    expect(readFileSync(path.join(runDir, "worlds", "default", "program.log"), "utf8")).toContain("# setup\nseeding admin with {{secret.WORLD_TOKEN}}\n");
  });

  it("stops a start that is waiting for ready at once when it is aborted, and reports it as aborted", async () => {
    writeFileSync(path.join(rootDir, "slow.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("pid", String(process.pid)); setInterval(() => {}, 1000);\n');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const begun = Date.now();
    const world = await starter().start("default", recipe({ ...SERVE, serve: { command: "node slow.mjs", timeout_ms: 60_000 } }), [], abort.signal);
    expect(world.ok).toBe(false);
    if (world.ok) return;
    expect(world.aborted).toBe(true);
    expect(Date.now() - begun).toBeLessThan(3_000);
    expect(await alive(Number(readFileSync(path.join(rootDir, "pid"), "utf8")))).toBe(false);
  });
});

describe("a world nukadoko does not serve", () => {
  it.each([
    ["localhost:4123", 'must be an http: or https: URL, such as "http://localhost:3000"'],
    [
      "http://user:hunter2@127.0.0.1:1",
      "must not hold a user or a password: fetch refuses such a URL, and every record names the world's URL; a step sends credentials itself, from an env file",
    ],
  ])("refuses a url function that answers %s, without quoting it", async (answer, reason) => {
    const world = await starter().start("default", recipe({ url: () => answer }), []);
    expect(world.ok ? null : world.message).toBe(`the program did not start for world default: the url function's answer ${reason}`);
    expect(world.ok ? null : world.message).not.toContain("hunter2");
  });


  it("fills {port} with the url's port, as written or the scheme's, in env, in prepare, and for setup", async () => {
    const seen: (number | undefined)[] = [];
    const cases = [
      ["https://a.example", "443"],
      ["http://a.example", "80"],
      ["http://127.0.0.1:9/app", "9"],
      ["https://a.example:8443", "8443"],
    ] as const;
    for (const [url, port] of cases) {
      const world = await startOk(
        await starter().start(
          "default",
          recipe({
            url: () => url,
            env: { PORT: "{port}" },
            prepare: [["node", "-e", "console.log(`prepared on ${process.argv[1]}`)", "{port}"]],
            setup: (given) => {
              seen.push(given.port);
            },
          }),
          [],
        ),
      );
      expect(world.view.env).toEqual({ PORT: port });
      expect(readFileSync(path.join(runDir, "worlds", "default", "program.log"), "utf8")).toContain(`prepared on ${port}\n`);
      await world.stop();
      rmSync(path.join(runDir, "worlds", "default"), { recursive: true, force: true });
    }
    expect(seen).toEqual(cases.map(([, port]) => Number(port)));
  });

  it("reaches a url, a function of the world, and starts nothing", async () => {
    const progress = createCaptureSink();
    const world = await startOk(
      await starter(progress).start("pr-12", recipe({ environments: { "pr-12": { url: ({ name }) => `https://${name}.preview.example` } } }, "pr-12"), []),
    );
    expect(world.view).toEqual({
      name: "pr-12",
      url: "https://pr-12.preview.example",
      env: {},
      secrets: [
        { name: "WORLD_TOKEN", value: expect.any(String) },
        { name: "WORLD_TRACE_IDS", value: expect.stringMatching(/^[0-9a-f]{8}$/), keep: "trace-ids" },
      ],
      log: null,
      dir: path.join(runDir, "worlds", "pr-12"),
      tracePrefix: expect.stringMatching(/^[0-9a-f]{8}$/),
      events: null,
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
      // nukadoko does not read the log or the events of a program it did
      // not start.
      program_log: null,
      events: null,
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
