import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { commandWords, programUrlProblem, urlPort, type Command, type ProgramRecipe, type ProgramWorld, type TimedCommand } from "../config/program-schema.js";
import { collectLateLines, type LateSlice, type TracedStep } from "../context/program-log-slice.js";
import { newTracePrefix } from "../context/trace-context.js";
import { windowsSpawnPlan } from "../context/windows-command.js";
import type { RunWorld, RunWorldCommand } from "../record/run-result.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { shellWord } from "../shell/shell-word.js";
import { createLineBuffer } from "../sink/line-buffer.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { captureOutput } from "./in-process-output.js";
import { describePlaceholderGap, fillPlaceholders, placeholderGaps, type PlaceholderValues } from "./placeholders.js";
import { groupAlive } from "./process-group.js";
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
// Every command runs in a process group of its own on POSIX, and stopping
// it signals the whole group: `npm start` or `bin/rails server` start the
// program as a child, and stopping only the process nukadoko spawned left
// that child holding the port. A group of its own also keeps a terminal's
// Ctrl-C from reaching it before nukadoko stops it in order. Stopping a
// group sends it SIGTERM and gives the whole group the grace period, until
// no process of it is left (src/program/process-group.ts) or 5 seconds
// pass, then SIGKILL to what is left: a server that a shell or `npm start`
// started can still be writing its last lines after the leader exits. A
// `build` or `prepare` command's group is killed once the command exits, so a child
// it left behind neither outlives the phase nor holds its output pipe
// open, which would keep the phase from ending at all. On Windows a signal
// ends only the process it names, so the whole tree ends with `taskkill /t
// /f`, the way `runCommand` already starts programs there
// (src/context/windows-command.ts); a process whose parent already exited
// is out of that tree's reach there.
//
// Every phase has a limit: a `build` or `prepare` command its
// `timeout_ms`, `serve` its `timeout_ms` to answer `ready`, and `setup`
// and a `url` function theirs (src/config/program-schema.ts). A phase past
// its limit is stopped and fails the world, naming the phase. A function
// cannot be stopped from outside, so a `setup` or a `url` function past
// its limit is abandoned: the world fails without waiting for it, and the
// `signal` it was given is aborted, which stops it only if it honours the
// signal. Each phase prints one line as it starts, so a terminal says what
// a long wait is waiting on.
//
// A start the caller aborts (a signal to nukadoko) kills the running
// phase's group at once, abandons a running function the same way, and
// returns a failed world marked `aborted`, which no finding reports.
//
// `setup` and a `url` function run in nukadoko's own process, so what
// they print would reach the terminal unredacted, a `{token}` included.
// What the function's own async work prints goes to the progress sink and
// to program.log instead, redacted, until the function settles or is
// abandoned (src/program/in-process-output.ts); what any other code prints
// meanwhile goes where it always goes.
//
// When the world stops, after the program has, one pass over its log finds
// the lines of each step that arrived after the step's record was written
// (src/context/program-log-slice.ts), and counts the lines that carry any
// trace id of the world, which is how the run tells a program that does
// not tag its lines from one whose lines all came late.
//
// A program nukadoko started must not outlive nukadoko, however nukadoko
// ends: a signal that arrives while a world is still starting, a step that
// calls process.exit, or a crash. Every child this module starts is listed
// until it is done with, and one `exit` listener kills what is still
// listed. An `exit` listener runs synchronously, so it kills at once
// (SIGKILL to the group, or a synchronous taskkill) instead of the stop's
// SIGTERM and grace period: nothing would be left to wait out the grace.

/** A step of the world's pass, as its record states it. */
export interface WorldStep extends TracedStep {
  /** How many requests it sent to the world with a `traceparent`. */
  readonly stamped: number;
}

export interface WorldStop {
  /** A sentence when the program had already exited during the pass,
   * which explains a pass whose requests found nothing listening; `null`
   * otherwise. */
  readonly exitedEarly: string | null;
  /** Each step's lines of the program's log that arrived after its record
   * was written, by trace id. Empty when nukadoko did not read the log. */
  readonly late: ReadonlyMap<string, LateSlice>;
}

export interface StartedWorld {
  readonly ok: true;
  readonly view: WorldView;
  /** Stops the program and closes the log, then finds the late lines of
   * `steps`, the pass's steps (module header). */
  stop(steps?: readonly WorldStep[]): Promise<WorldStop>;
  /** The world's run.json entry, as of now. */
  record(): RunWorld;
}

export interface FailedWorld {
  readonly ok: false;
  /** Why the program did not start, with the end of its log. */
  readonly message: string;
  /** The caller aborted the start; nothing failed on the program's side. */
  readonly aborted: boolean;
  record(): RunWorld;
}

export interface WorldStarterOptions {
  /** The root of the tree the program is built from. */
  readonly rootDir: string;
  /** The directory world `name` keeps its state and its log in. */
  readonly worldDir: (name: string) => string;
  /** A path inside a world's directory as its record names it. */
  readonly recordPath: (absolutePath: string) => string;
  /** A path as the terminal and a finding name it: relative to the
   * project root, wherever the record's own paths are relative to. */
  readonly displayPath: (absolutePath: string) => string;
  /** One line per world that ran something, as it is ready. */
  readonly progress: WritableSink;
}

export interface WorldStarter {
  /** Starts world `name`. `abort` stops the start at once (module
   * header). */
  start(name: string, recipe: ProgramRecipe, secrets: SecretSet, abort?: AbortSignal): Promise<StartedWorld | FailedWorld>;
}

const READY_POLL_MS = 100;
const READY_REQUEST_MS = 2_000;
const STOP_GRACE_MS = 5_000;
const STREAMS_CLOSE_MS = 1_000;
const GROUP_POLL_MS = 50;

class WorldStartError extends Error {}

/** A phase reached its limit. */
class WorldStartLimit extends WorldStartError {}

/** The caller aborted the start. */
class WorldStartAborted extends Error {}

/** Rejects with WorldStartAborted once `abort` fires. */
function abortedBy(abort: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (abort === undefined) return;
    const fire = (): void => reject(new WorldStartAborted("the start was aborted"));
    if (abort.aborted) fire();
    else abort.addEventListener("abort", fire, { once: true });
  });
}

/** `work`, or a WorldStartError that names `what` once `timeoutMs`
 * passes first, or WorldStartAborted once `abort` fires first. */
async function withinLimit<T>(work: Promise<T>, timeoutMs: number, what: string, abort: AbortSignal | undefined): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WorldStartLimit(`${what} did not finish within ${timeoutMs} ms (timeout_ms)`)), timeoutMs);
  });
  const aborted = abortedBy(abort);
  // Neither loser may surface as an unhandled rejection.
  limit.catch(() => {});
  aborted.catch(() => {});
  try {
    return await Promise.race([work, limit, aborted]);
  } finally {
    clearTimeout(timer);
  }
}

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
    async start(name, recipe, secrets, abort) {
      const dir = options.worldDir(name);
      mkdirSync(dir, { recursive: true });
      const token = randomBytes(16).toString("hex");
      const tracePrefix = newTracePrefix();
      // The trace id entry is no secret: it keeps the world's trace ids as
      // they are wherever the world's secrets redact (src/secrets/types.ts),
      // so a short secret inside one never changes the id a line carries.
      const worldSecrets: SecretSet = [
        { name: "WORLD_TOKEN", value: token },
        { name: "WORLD_TRACE_IDS", value: tracePrefix, keep: "trace-ids" },
      ];
      const allSecrets: SecretSet = [...secrets, ...worldSecrets];
      const log = openProgramLog(path.join(dir, "program.log"), allSecrets);
      const commands: RunWorldCommand[] = [];
      const timings: Partial<Record<"build_ms" | "prepare_ms" | "serve_ms" | "setup_ms" | "stop_ms", number>> = {};
      let url: string | undefined;
      let server: ServeProcess | undefined;
      let programLog: RunWorld["program_log"];

      const record = (error: string | null): RunWorld => ({
        name,
        tree: "head",
        url: url === undefined ? null : redactString(url, allSecrets),
        commands: commands.map((command) => ({ phase: command.phase, argv: command.argv.map((word) => redactString(word, allSecrets)) })),
        timings: { ...timings },
        log: log.written ? options.recordPath(log.path) : null,
        error: error === null ? null : redactString(error, allSecrets),
        ...(programLog === undefined ? {} : { program_log: programLog }),
      });
      const run = (phase: RunWorldCommand["phase"], argv: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<void> => {
        commands.push({ phase, argv });
        return runToEnd(phase, argv, timeoutMs, env, options.rootDir, log, abort);
      };
      // One line per phase as it starts, redacted: a `{token}` can be in a
      // command's words.
      const announce = (text: string): void => {
        options.progress.write(`${redactString(`world ${name}: ${text}`, allSecrets)}\n`);
      };
      // What `setup` or a `url` function prints, redacted, on the
      // terminal and in the log.
      const printed = createLineBuffer((line) => {
        log.note(line);
        options.progress.write(`${redactString(line, allSecrets)}\n`);
      });
      // Runs `setup` or a `url` function under its own capture and its
      // limit. One past its limit, or running when the start is aborted,
      // is abandoned (module header): the capture ends, what it printed so
      // far is flushed with a line that says so, and its signal is aborted.
      const inProcess = async <T>(what: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        const capture = captureOutput(
          (text) => printed.push(text),
          (text) => redactString(text, allSecrets),
        );
        let settled = false;
        let ended: unknown;
        try {
          const work = capture.run(() => fn(controller.signal)).finally(() => {
            settled = true;
          });
          return await withinLimit(work, timeoutMs, what, abort);
        } catch (error) {
          ended = error;
          throw error;
        } finally {
          capture.end();
          printed.flush();
          if (!settled) {
            const when = ended instanceof WorldStartLimit ? `at its limit (${timeoutMs} ms)` : "when the start was stopped";
            log.note(`# ${what} was abandoned ${when}; it stops only if it honours its signal`);
            controller.abort(new Error(`${what} was abandoned ${when}`));
          }
        }
      };

      try {
        // Refused before the build, which may be shared with a world that
        // has no gap: nothing of this world runs. The commands refuse it
        // earlier still, for every world they start (src/cli/run.ts).
        const gap = placeholderGaps(recipe)[0];
        if (gap !== undefined) throw new WorldStartError(describePlaceholderGap(gap));
        const buildCommands = recipe.build.map((entry, index) => ({
          argv: filledArgv(entry.command, { root: options.rootDir }, `build[${index}]`),
          timeoutMs: entry.timeout_ms,
        }));
        if (buildCommands.length > 0) {
          const key = JSON.stringify(buildCommands.map((command) => command.argv));
          const earlier = builds.get(key);
          if (earlier === undefined) {
            const started = Date.now();
            announce(`build started: ${buildCommands.map((command) => display(command.argv)).join("; ")}`);
            const done = (async () => {
              for (const command of buildCommands) await run("build", command.argv, command.timeoutMs, process.env);
            })();
            builds.set(key, { world: name, done });
            await done;
            timings.build_ms = Date.now() - started;
          } else {
            log.note(`# build: the same commands already ran for world ${earlier.world}`);
            // The earlier world's build has its own limit; this world
            // waits for it, or for its own abort.
            const aborted = abortedBy(abort);
            aborted.catch(() => {});
            await Promise.race([
              earlier.done.catch(() => {
                throw new WorldStartError(`the build failed in world ${earlier.world}`);
              }),
              aborted,
            ]);
          }
        }

        const reach = recipe.reach;
        let port =
          reach.kind !== "serve" ? undefined : reach.serve.port === "auto" ? await freePort() : await portNobodyAnswers(reach.serve.port);
        const place = { name, root: options.rootDir, dir };
        if (reach.kind === "serve") {
          url = `http://localhost:${port}`;
        } else if (reach.kind === "url") {
          const reachUrl = reach.url;
          url =
            typeof reachUrl === "string"
              ? reachUrl
              : await inProcess("the url function", reach.timeout_ms, async (signal) => reachUrl({ ...place, signal }));
          // A string `url` was checked at load; what a function returns
          // is checked here, by the same rule, without quoting it.
          const problem = programUrlProblem(String(url));
          if (problem !== undefined) throw new WorldStartError(`the url function's answer ${problem}`);
          // Every world with a URL has a port (src/program/placeholders.ts).
          port = urlPort(url);
        }
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
          const prepareCommands = recipe.prepare.map((entry: TimedCommand, index) => ({
            argv: filledArgv(entry.command, values, `prepare[${index}]`),
            timeoutMs: entry.timeout_ms,
          }));
          announce(`prepare started: ${prepareCommands.map((command) => display(command.argv)).join("; ")}`);
          for (const command of prepareCommands) await run("prepare", command.argv, command.timeoutMs, childEnv);
          timings.prepare_ms = Date.now() - started;
        }

        if (reach.kind === "serve") {
          const argv = filledArgv(reach.serve.command, values, "serve.command");
          commands.push({ phase: "serve", argv });
          const started = Date.now();
          const readyUrl = new URL(reach.serve.ready, url).href;
          announce(`serve started: ${display(argv)}, waiting for ${readyUrl}`);
          server = startServe(argv, childEnv, options.rootDir, log);
          await waitUntilReady(server, readyUrl, reach.serve.timeout_ms, abort);
          timings.serve_ms = Date.now() - started;
        }

        const setup = recipe.setup;
        if (setup !== undefined) {
          const started = Date.now();
          announce("setup started");
          log.note("# setup");
          await inProcess("setup", setup.timeout_ms, async (signal) => {
            const world: ProgramWorld = { ...place, signal, url, port, env: { ...worldEnv } };
            try {
              await setup.run(world);
            } catch (error) {
              throw new WorldStartError(`setup threw: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
          timings.setup_ms = Date.now() - started;
        }

        if (commands.length > 0 || recipe.setup !== undefined) announce(readyLine(timings, url, log.written ? options.displayPath(log.path) : null));
        const view: WorldView = { name, url, env: worldEnv, secrets: worldSecrets, log: server === undefined ? null : log.path, dir, tracePrefix };
        const running = server;
        // A world at a URL has a log nukadoko cannot read; a world with no
        // URL sends nothing to stamp.
        if (url !== undefined && running === undefined) programLog = null;
        return {
          ok: true,
          view,
          async stop(steps) {
            const started = Date.now();
            const exitedEarly = running === undefined || running.exit === null ? null : `the program ${describeExit(running)} during the pass`;
            await running?.stop();
            log.close();
            timings.stop_ms = Date.now() - started;
            let late: ReadonlyMap<string, LateSlice> = new Map();
            if (running !== undefined && steps !== undefined) {
              const found = collectLateLines(log.path, tracePrefix, steps, allSecrets);
              late = found.late;
              const sum = (count: (step: WorldStep) => number): number => steps.reduce((total, step) => total + count(step), 0);
              programLog = {
                stamped: sum((step) => step.stamped),
                lines: sum((step) => step.lines),
                late: [...late.values()].reduce((total, slice) => total + slice.lines, 0),
                tagged: found.tagged,
              };
            }
            return {
              exitedEarly: exitedEarly === null ? null : redactString(`${exitedEarly}; see ${options.displayPath(log.path)}`, allSecrets),
              late,
            };
          },
          record: () => record(null),
        };
      } catch (error) {
        const aborted = error instanceof WorldStartAborted || abort?.aborted === true;
        if (aborted) server?.kill();
        await server?.stop();
        const cause = aborted
          ? "the start was stopped before the program was ready"
          : error instanceof WorldStartError
            ? error.message
            : `nukadoko could not start it: ${error instanceof Error ? error.message : String(error)}`;
        const tail = log.tail();
        log.close();
        const message = redactString(
          `the program did not start for world ${name}: ${cause}${tail === "" ? "" : `. The end of ${options.displayPath(log.path)}:\n${tail}`}`,
          allSecrets,
        );
        return { ok: false, message, aborted, record: () => record(cause) };
      }
    },
  };
}

/** The last answer the ready check got, for the message when none was
 * 2xx. A redirect names where it pointed, since that is usually the
 * mistake: `ready` names a path that sends a visitor to a login page. */
function describeAnswer(response: Response): string {
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location !== null) {
    return `the last answer was ${response.status}, a redirect to ${location}, which the ready check does not follow`;
  }
  return `the last answer was ${response.status}`;
}

function filledText(text: string, values: PlaceholderValues, where: string): string {
  const filled = fillPlaceholders(text, values);
  if ("text" in filled) return filled.text;
  // Not reached: `start` refused every gap before anything ran.
  throw new WorldStartError(`${where} names {${filled.missing}}, which has no value here`);
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

/** Runs one build or prepare command to its end, in a process group of
 * its own, and kills what is left of the group once the command exits
 * (module header). A start failure, a non-zero exit, or `timeoutMs`
 * passing is a WorldStartError naming the command; `abort` kills the group
 * at once. */
function runToEnd(
  phase: string,
  argv: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  cwd: string,
  log: ProgramLog,
  abort: AbortSignal | undefined,
): Promise<void> {
  log.note(`$ ${display(argv)}`);
  const plan = spawnPlan(argv, env);
  const groupOfItsOwn = process.platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: plan.verbatim,
      detached: groupOfItsOwn,
    });
    const unlist = killOnExit(child, true);
    const group = processGroup(child, groupOfItsOwn);
    const out = log.stream();
    const err = log.stream();
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    let settled = false;
    let failure: WorldStartError | WorldStartAborted | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopping: Promise<void> | undefined;
    const onAbort = (): void => {
      failure ??= new WorldStartAborted("the start was aborted");
      group.kill();
    };
    const finish = (outcome: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort?.removeEventListener("abort", onAbort);
      unlist();
      out.flush();
      err.flush();
      if (outcome === undefined) resolve();
      else reject(outcome);
    };
    timer = setTimeout(() => {
      failure ??= new WorldStartError(`${phase} command ${display(argv)} did not finish within ${timeoutMs} ms (timeout_ms)`);
      stopping = group.stop();
    }, timeoutMs);
    if (abort?.aborted === true) onAbort();
    else abort?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => finish(failure ?? new WorldStartError(`${phase} command ${display(argv)} could not start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      // What the command left in its group goes with it, or a child that
      // holds the output pipe keeps `close` from ever coming. A group
      // being stopped past its limit keeps its grace period instead.
      if (stopping === undefined) group.kill();
      void (stopping ?? Promise.resolve()).then(() => Promise.race([closed, delay(STREAMS_CLOSE_MS)])).then(() => {
        if (failure !== undefined) finish(failure);
        else if (code === 0) finish(undefined);
        else finish(new WorldStartError(`${phase} command ${display(argv)} exited ${signal === null ? `with code ${code}` : `on ${signal}`}`));
      });
    });
  });
}

/** Signals a child's process group on POSIX, or its tree on Windows.
 * `stop` gives the whole group the grace period (module header). */
function processGroup(child: ChildProcess, groupOfItsOwn: boolean): { signal(signal: NodeJS.Signals): void; kill(): void; stop(): Promise<void> } {
  const signal = (name: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => child.kill());
      } else if (groupOfItsOwn) {
        process.kill(-child.pid, name);
      } else {
        child.kill(name);
      }
    } catch {
      // The group is gone already: nothing is left to signal.
    }
  };
  return {
    signal,
    kill: () => signal("SIGKILL"),
    async stop() {
      signal("SIGTERM");
      const running = (): boolean =>
        groupOfItsOwn && child.pid !== undefined ? groupAlive(child.pid) : child.exitCode === null && child.signalCode === null;
      await graceFor(running);
      signal("SIGKILL");
    },
  };
}

/** Waits until `running` answers false, or the grace period passes. The
 * wait between two probes holds the event loop open, unlike `delay`: once
 * the leader has exited, nothing else may, and an unref'd timer would let
 * the process end with the stop still pending. The wait is bounded by the
 * grace period. */
async function graceFor(running: () => boolean): Promise<void> {
  const deadline = Date.now() + STOP_GRACE_MS;
  while (running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
}

interface ServeProcess {
  readonly argv: readonly string[];
  /** How the program exited, once it has. */
  readonly exit: { code: number | null; signal: NodeJS.Signals | null; error?: string } | null;
  /** Resolves once the program has exited, however it went. */
  readonly exited: Promise<void>;
  /** Kills the group at once, before `stop`, for a start that was aborted. */
  kill(): void;
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
    kill() {
      if (process.platform === "win32") {
        if (exit === null && child.pid !== undefined) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => child.kill());
      } else {
        signalGroup("SIGKILL");
      }
    },
    stop() {
      stopping ??= (async () => {
        if (process.platform === "win32") {
          if (exit === null && child.pid !== undefined) {
            spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => child.kill());
          }
          await exited;
        } else {
          // The whole group gets the grace period, a child the program
          // started included, which can outlive the leader; what is left
          // after it is killed, so nothing of this world holds the port.
          const pid = child.pid;
          if (pid !== undefined && groupAlive(pid)) {
            signalGroup("SIGTERM");
            await graceFor(() => groupAlive(pid));
            signalGroup("SIGKILL");
          }
          await exited;
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

async function waitUntilReady(server: ServeProcess, readyUrl: string, timeoutMs: number, abort: AbortSignal | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const aborted = abortedBy(abort);
  aborted.catch(() => {});
  let lastAnswer: string | undefined;
  for (;;) {
    if (abort?.aborted === true) throw new WorldStartAborted("the start was aborted");
    if (server.exit !== null) {
      throw new WorldStartError(`serve command ${display(server.argv)} ${describeExit(server)} before ${readyUrl} answered`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WorldStartError(
        `serve command ${display(server.argv)} did not answer ${readyUrl} with a 2xx status within ${timeoutMs} ms (timeout_ms)${lastAnswer === undefined ? "" : `; ${lastAnswer}`}`,
      );
    }
    try {
      const signals = [AbortSignal.timeout(Math.min(READY_REQUEST_MS, remaining)), ...(abort === undefined ? [] : [abort])];
      // A redirect is an answer, not ready: following one would let a
      // ready path that sends the check elsewhere, a login page or
      // another host, answer for the program.
      const response = await fetch(readyUrl, { signal: AbortSignal.any(signals), redirect: "manual" });
      await response.body?.cancel();
      if (response.ok) return;
      lastAnswer = describeAnswer(response);
    } catch {
      // Not listening yet, or not answering in time: the next poll asks again.
    }
    await Promise.race([delay(READY_POLL_MS), server.exited, aborted]);
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

/** `build 2.1s, prepare 0.4s, serve 1.9s, http://localhost:41873  (log <path>)`,
 * after `world <name>: `. */
function readyLine(timings: RunWorld["timings"], url: string | undefined, log: string | null): string {
  const phases = (["build", "prepare", "serve", "setup"] as const).flatMap((phase) => {
    const ms = timings[`${phase}_ms`];
    return ms === undefined ? [] : [`${phase} ${(ms / 1000).toFixed(1)}s`];
  });
  return `${[...phases, ...(url === undefined ? [] : [url])].join(", ")}${log === null ? "" : `  (log ${log})`}`;
}
