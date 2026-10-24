import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { commandWords, type Command, type ProgramRecipe, type ProgramWorld } from "../config/program-schema.js";
import { windowsSpawnPlan } from "../context/windows-command.js";
import type { RunWorld, RunWorldCommand } from "../record/run-result.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { shellWord } from "../shell/shell-word.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { fillPlaceholders, type PlaceholderValues } from "./placeholders.js";
import { openProgramLog, type ProgramLog } from "./program-log.js";
import type { WorldView } from "./world-view.js";

// Responsibility: own the program under test for one world (docs/spec.md
// "Program"). A world is one pass of a run against one program: nukadoko
// builds the tree (once per tree per run, shared by every world of it),
// prepares the world's state with the world's env, starts `serve` on a
// port it gives the world, waits until `ready` answers 2xx, runs `setup`,
// and stops the program after the pass. A world with `url` starts nothing:
// its program is somewhere nukadoko does not run. Boundary: when a world
// starts and stops is the command's (src/cli/run.ts, src/cli/do.ts); this
// module never reads a feature file or a step.
//
// Every command runs with no shell, in the tree's root, its output into
// the world's program.log (src/program/program-log.ts). A failure at any
// phase stops what already started and is returned, not thrown, with the
// end of the log, so the caller reports why the program did not start and
// still records the world.
//
// The server runs in a process group of its own on POSIX, and stopping it
// signals the whole group: `npm start` or `bin/rails server` start the
// program as a child, and stopping only the process nukadoko spawned left
// that child holding the port. A group of its own also keeps a terminal's
// Ctrl-C from reaching it before nukadoko stops it in order. On Windows a
// signal ends only the process it names, so the whole tree ends with
// `taskkill /t /f`, the way `runCommand` already starts programs there
// (src/context/windows-command.ts).
//
// A program nukadoko started must not outlive nukadoko, however nukadoko
// ends: a signal that arrives while a world is still starting, a step that
// calls process.exit, or a crash. Every child this module starts is listed
// until it is done with, and one `exit` listener kills what is still
// listed. An `exit` listener runs synchronously, so it kills at once
// (SIGKILL to the group, or a synchronous taskkill) instead of the stop's
// SIGTERM and grace period: nothing would be left to wait out the grace.

export interface StartedWorld {
  readonly ok: true;
  readonly view: WorldView;
  /** Stops the program and closes the log. Resolves with a sentence when
   * the program had already exited during the pass, which explains a pass
   * whose requests found nothing listening; `null` otherwise. */
  stop(): Promise<string | null>;
  /** The world's run.json entry, as of now. */
  record(): RunWorld;
}

export interface FailedWorld {
  readonly ok: false;
  /** Why the program did not start, with the end of its log. */
  readonly message: string;
  record(): RunWorld;
}

export interface WorldStarterOptions {
  /** The root of the tree the program is built from. */
  readonly rootDir: string;
  /** The directory world `name` keeps its state and its log in. */
  readonly worldDir: (name: string) => string;
  /** A path inside a world's directory as its record names it. */
  readonly recordPath: (absolutePath: string) => string;
  /** One line per world that ran something, as it is ready. */
  readonly progress: WritableSink;
}

export interface WorldStarter {
  start(name: string, recipe: ProgramRecipe, secrets: SecretSet): Promise<StartedWorld | FailedWorld>;
}

const READY_POLL_MS = 100;
const READY_REQUEST_MS = 2_000;
const STOP_GRACE_MS = 5_000;
const STREAMS_CLOSE_MS = 1_000;

class WorldStartError extends Error {}

const killedOnExit = new Map<ChildProcess, () => void>();
let exitListenerAdded = false;

/** Kills `child` (its whole group or tree, when `group` is set) if this
 * process exits while it is still listed; the returned function lists it
 * no more. */
function killOnExit(child: ChildProcess, group: boolean): () => void {
  killedOnExit.set(child, () => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else if (group) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  });
  if (!exitListenerAdded) {
    exitListenerAdded = true;
    process.on("exit", () => {
      for (const kill of killedOnExit.values()) kill();
    });
  }
  return () => killedOnExit.delete(child);
}

/** One starter per run: it remembers which builds already ran, so a tree
 * builds once however many worlds it serves. */
export function createWorldStarter(options: WorldStarterOptions): WorldStarter {
  const builds = new Map<string, { world: string; done: Promise<void> }>();
  return {
    async start(name, recipe, secrets) {
      const dir = options.worldDir(name);
      mkdirSync(dir, { recursive: true });
      const token = randomBytes(16).toString("hex");
      const worldSecrets: SecretSet = [{ name: "WORLD_TOKEN", value: token }];
      const allSecrets: SecretSet = [...secrets, ...worldSecrets];
      const log = openProgramLog(path.join(dir, "program.log"), allSecrets);
      const commands: RunWorldCommand[] = [];
      const timings: Partial<Record<"build_ms" | "prepare_ms" | "serve_ms" | "setup_ms" | "stop_ms", number>> = {};
      let url: string | undefined;
      let server: ServeProcess | undefined;

      const record = (error: string | null): RunWorld => ({
        name,
        tree: "head",
        url: url === undefined ? null : redactString(url, allSecrets),
        commands: commands.map((command) => ({ phase: command.phase, argv: command.argv.map((word) => redactString(word, allSecrets)) })),
        timings: { ...timings },
        log: log.written ? options.recordPath(log.path) : null,
        error: error === null ? null : redactString(error, allSecrets),
      });
      const run = (phase: RunWorldCommand["phase"], argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> => {
        commands.push({ phase, argv });
        return runToEnd(phase, argv, env, options.rootDir, log);
      };

      try {
        const buildArgvs = recipe.build.map((command, index) => filledArgv(command, { root: options.rootDir }, `build[${index}]`));
        if (buildArgvs.length > 0) {
          const key = JSON.stringify(buildArgvs);
          const earlier = builds.get(key);
          if (earlier === undefined) {
            const started = Date.now();
            const done = (async () => {
              for (const argv of buildArgvs) await run("build", argv, process.env);
            })();
            builds.set(key, { world: name, done });
            await done;
            timings.build_ms = Date.now() - started;
          } else {
            log.note(`# build: the same commands already ran for world ${earlier.world}`);
            await earlier.done.catch(() => {
              throw new WorldStartError(`the build failed in world ${earlier.world}`);
            });
          }
        }

        const reach = recipe.reach;
        const port =
          reach.kind !== "serve" ? undefined : reach.serve.port === "auto" ? await freePort() : await portNobodyAnswers(reach.serve.port);
        const place = { name, root: options.rootDir, dir };
        url =
          reach.kind === "serve"
            ? `http://localhost:${port}`
            : reach.kind === "url"
              ? typeof reach.url === "string"
                ? reach.url
                : await reach.url(place)
              : undefined;
        const values: PlaceholderValues = {
          root: options.rootDir,
          dir,
          world: name,
          token,
          ...(port === undefined ? {} : { port: String(port) }),
          ...(url === undefined ? {} : { url }),
        };
        const worldEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(recipe.env)) worldEnv[key] = filledText(value, values, `env.${key}`);
        const childEnv: NodeJS.ProcessEnv = { ...process.env, ...worldEnv };

        if (recipe.prepare.length > 0) {
          const started = Date.now();
          for (const [index, command] of recipe.prepare.entries()) await run("prepare", filledArgv(command, values, `prepare[${index}]`), childEnv);
          timings.prepare_ms = Date.now() - started;
        }

        if (reach.kind === "serve") {
          const argv = filledArgv(reach.serve.command, values, "serve.command");
          commands.push({ phase: "serve", argv });
          const started = Date.now();
          server = startServe(argv, childEnv, options.rootDir, log);
          await waitUntilReady(server, new URL(reach.serve.ready, url).href, reach.serve.timeout_ms);
          timings.serve_ms = Date.now() - started;
        }

        if (recipe.setup !== undefined) {
          const started = Date.now();
          const world: ProgramWorld = { ...place, url, port, env: { ...worldEnv } };
          try {
            await recipe.setup(world);
          } catch (error) {
            throw new WorldStartError(`setup threw: ${error instanceof Error ? error.message : String(error)}`);
          }
          timings.setup_ms = Date.now() - started;
        }

        if (commands.length > 0 || recipe.setup !== undefined) {
          options.progress.write(`${readyLine(name, timings, url, log.written ? path.relative(options.rootDir, log.path) : null)}\n`);
        }
        const view: WorldView = { name, url, env: worldEnv, secrets: worldSecrets, log: server === undefined ? null : log.path };
        const running = server;
        return {
          ok: true,
          view,
          async stop() {
            const started = Date.now();
            const exitedEarly = running === undefined || running.exit === null ? null : `the program ${describeExit(running)} during the pass`;
            await running?.stop();
            log.close();
            timings.stop_ms = Date.now() - started;
            return exitedEarly === null ? null : redactString(`${exitedEarly}; see ${options.recordPath(log.path)}`, allSecrets);
          },
          record: () => record(null),
        };
      } catch (error) {
        await server?.stop();
        const cause = error instanceof WorldStartError ? error.message : `nukadoko could not start it: ${error instanceof Error ? error.message : String(error)}`;
        const tail = log.tail();
        log.close();
        const message = redactString(
          `the program did not start for world ${name}: ${cause}${tail === "" ? "" : `. The end of ${options.recordPath(log.path)}:\n${tail}`}`,
          allSecrets,
        );
        return { ok: false, message, record: () => record(cause) };
      }
    },
  };
}

function filledText(text: string, values: PlaceholderValues, where: string): string {
  const filled = fillPlaceholders(text, values);
  if ("text" in filled) return filled.text;
  // A build fills {root} alone, and a world lacks only what it does not reach.
  const why = where.startsWith("build")
    ? "build runs once per tree, before any world exists"
    : filled.missing === "port"
      ? "this world does not serve"
      : "this world has neither serve nor url";
  throw new WorldStartError(`${where} names {${filled.missing}}, which has no value here: ${why}`);
}

function filledArgv(command: Command, values: PlaceholderValues, where: string): string[] {
  return commandWords(command).map((word) => filledText(word, values, where));
}

function display(argv: readonly string[]): string {
  return argv.map(shellWord).join(" ");
}

function spawnPlan(argv: readonly string[], env: NodeJS.ProcessEnv): { file: string; args: string[]; verbatim: boolean } {
  const [file, ...args] = argv as [string, ...string[]];
  return process.platform === "win32" ? windowsSpawnPlan(file, args, env) : { file, args, verbatim: false };
}

/** Runs one build or prepare command to its end; a start failure or a
 * non-zero exit is a WorldStartError naming the command. */
function runToEnd(phase: string, argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string, log: ProgramLog): Promise<void> {
  log.note(`$ ${display(argv)}`);
  const plan = spawnPlan(argv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: plan.verbatim });
    const unlist = killOnExit(child, false);
    child.once("close", unlist);
    child.once("error", unlist);
    const out = log.stream();
    const err = log.stream();
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", (error) => reject(new WorldStartError(`${phase} command ${display(argv)} could not start: ${error.message}`)));
    child.once("close", (code, signal) => {
      out.flush();
      err.flush();
      if (code === 0) resolve();
      else reject(new WorldStartError(`${phase} command ${display(argv)} exited ${signal === null ? `with code ${code}` : `on ${signal}`}`));
    });
  });
}

interface ServeProcess {
  readonly argv: readonly string[];
  /** How the program exited, once it has. */
  readonly exit: { code: number | null; signal: NodeJS.Signals | null; error?: string } | null;
  /** Resolves once the program has exited, however it went. */
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

function describeExit(server: ServeProcess): string {
  const exit = server.exit!;
  if (exit.error !== undefined) return `could not start: ${exit.error}`;
  return `exited ${exit.signal === null ? `with code ${exit.code}` : `on ${exit.signal}`}`;
}

function startServe(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string, log: ProgramLog): ServeProcess {
  log.note(`$ ${display(argv)}`);
  const plan = spawnPlan(argv, env);
  const groupOfItsOwn = process.platform !== "win32";
  const child: ChildProcess = spawn(plan.file, plan.args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: plan.verbatim,
    detached: groupOfItsOwn,
  });
  // Listed until the stop below is done: a child the program started can
  // outlive the program itself, and the group goes with it.
  const unlist = killOnExit(child, true);
  const out = log.stream();
  const err = log.stream();
  child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
  let exit: ServeProcess["exit"] = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exit ??= { code, signal };
      resolve();
    });
    child.once("error", (error) => {
      exit ??= { code: null, signal: null, error: error.message };
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (groupOfItsOwn && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The group is gone already: nothing is left to signal.
    }
  };
  let stopping: Promise<void> | undefined;
  return {
    argv,
    get exit() {
      return exit;
    },
    exited,
    stop() {
      stopping ??= (async () => {
        if (process.platform === "win32") {
          if (exit === null && child.pid !== undefined) {
            spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => child.kill());
          }
          await exited;
        } else {
          if (exit === null) signalGroup("SIGTERM");
          const graceful = await Promise.race([exited.then(() => true), delay(STOP_GRACE_MS).then(() => false)]);
          // A child the program started can outlive it; the group goes
          // whole, so nothing of this world holds the port afterwards.
          signalGroup("SIGKILL");
          if (!graceful) await exited;
        }
        await Promise.race([closed, delay(STREAMS_CLOSE_MS)]);
        out.flush();
        err.flush();
        unlist();
      })();
      return stopping;
    },
  };
}

async function waitUntilReady(server: ServeProcess, readyUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (server.exit !== null) {
      throw new WorldStartError(`serve command ${display(server.argv)} ${describeExit(server)} before ${readyUrl} answered`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WorldStartError(`serve command ${display(server.argv)} did not answer ${readyUrl} with a 2xx status within ${timeoutMs} ms`);
    }
    try {
      const response = await fetch(readyUrl, { signal: AbortSignal.timeout(Math.min(READY_REQUEST_MS, remaining)) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Not listening yet, or not answering in time: the next poll asks again.
    }
    await Promise.race([delay(READY_POLL_MS), server.exited]);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** `port`, once nothing answers on it: a server already there would take
 * every request this world sends, and the scenarios would pass or fail on
 * its behalf. */
async function portNobodyAnswers(port: number): Promise<number> {
  const answers = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "localhost", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (answers) {
    throw new WorldStartError(
      `something already answers on port ${port}, so every request would reach a server nukadoko did not start; stop it, or write port: "auto"`,
    );
  }
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** `world default: build 2.1s, prepare 0.4s, serve 1.9s, http://localhost:41873  (log <path>)` */
function readyLine(name: string, timings: RunWorld["timings"], url: string | undefined, log: string | null): string {
  const phases = (["build", "prepare", "serve", "setup"] as const).flatMap((phase) => {
    const ms = timings[`${phase}_ms`];
    return ms === undefined ? [] : [`${phase} ${(ms / 1000).toFixed(1)}s`];
  });
  return `world ${name}: ${[...phases, ...(url === undefined ? [] : [url])].join(", ")}${log === null ? "" : `  (log ${log})`}`;
}
