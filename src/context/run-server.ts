import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { windowsSpawnPlan } from "./windows-command.js";

// Responsibility: `runServer`, the exported helper a fixture uses to start
// the program under test (an HTTP server) and stop it after the scenario.
// It starts a process and reports when it listens; it never decides what
// the program is, which port it takes, or how it reads that port.
//
// Readiness is an observation, not a guess: the URL's host and port accept
// a TCP connection, or the call fails, naming the URL, the wait, and the
// program's stderr. A log line ("listening on ...") would be a guess at
// what each program prints. An HTTP probe would be a guess at which path
// answers and with what status. The program has to listen at the URL
// itself: telling it a port through a `PORT` variable is a convention
// some servers follow and others ignore.
//
// A port that already accepts connections before the program starts is
// refused, because every request would then reach a server this call did
// not start (another run, a dev server, or a second `--concurrency`
// worker on the same fixed port), and the scenario would pass or fail on
// that server's behalf.
//
// It is an import, not a member of `ctx`, for the reason `runCommand` is:
// starting a process needs nothing the executor injects.
//
// On Windows a program is found and started the way `runCommand` starts
// one (windows-command.ts), so `runServer("npm", ["start"])` works there
// too. `stop()` ends the whole process tree with taskkill: a signal on
// Windows ends only the process it names, so stopping `cmd.exe` or
// `npm` alone left the server it started holding the port, and the next
// scenario was refused for a port it could not have known was taken.

export interface RunServerOptions {
  /** The URL the program listens at, such as the config's `baseURL`. A
   * fixture passes the `baseURL` fixture, which is `undefined` when the
   * config sets none, so `undefined` is accepted and refused by name. */
  url: string | undefined;
  /** The working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The child's whole environment, as for Node's own `spawn`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Milliseconds to wait for the port to accept a connection. Omit it for 10 seconds. */
  timeout?: number;
}

export interface RunningServer {
  /** The URL the program accepted a connection at. */
  readonly url: string;
  /** Ends the program with SIGTERM, then SIGKILL if it has not exited
   * 5 seconds later, and resolves once it has exited. On Windows it ends
   * the program and every process it started, with `taskkill /t /f`. */
  stop(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const STOP_GRACE_MS = 5_000;
const STDERR_TAIL_BYTES = 2_000;
const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/** The host and port a URL's server listens on, or why there is none. */
export function listenAddress(url: string): { host: string; port: number } | { refusal: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refusal: `runServer needs an http or https URL, and got ${JSON.stringify(url)}` };
  }
  const defaultPort = DEFAULT_PORTS[parsed.protocol];
  if (defaultPort === undefined || parsed.hostname === "") {
    return { refusal: `runServer needs an http or https URL, and got ${JSON.stringify(url)}` };
  }
  // A bracketed IPv6 literal is how the URL writes it, not how a socket takes it.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host, port: parsed.port === "" ? defaultPort : Number(parsed.port) };
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Starts `command` with `args`, with no shell, and resolves once
 * `options.url`'s host and port accept a TCP connection. Rejects when the
 * URL is missing or not http(s), when something already listens there,
 * when the program exits first, and when `options.timeout` passes; each
 * message names the URL and the program's stderr, and the program is
 * stopped before a timeout rejects.
 */
export async function runServer(command: string, args: readonly string[], options: RunServerOptions): Promise<RunningServer> {
  if (options.url === undefined) {
    throw new Error("runServer needs the URL the program listens at, and got none: set baseURL in the nukadoko config");
  }
  const url = options.url;
  const address = listenAddress(url);
  if ("refusal" in address) throw new Error(address.refusal);
  const where = `${address.host}:${address.port}`;
  const named = [command, ...args].join(" ");
  if (await accepts(address.host, address.port)) {
    throw new Error(
      `runServer did not start ${named}: something already accepts connections at ${where}, so every request would reach a server it did not start; stop that server, or run one scenario at a time`,
    );
  }

  const env = options.env ?? process.env;
  const plan =
    process.platform === "win32" ? windowsSpawnPlan(command, args, env) : { file: command, args: [...args], verbatim: false };
  const child = spawn(plan.file, plan.args, {
    cwd: resolve(options.cwd ?? process.cwd()),
    env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsVerbatimArguments: plan.verbatim,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let startError: Error | null = null;
  const exit = new Promise<void>((resolvePromise) => {
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolvePromise();
    });
    child.once("error", (error) => {
      startError = error;
      exited ??= { code: null, signal: null };
      resolvePromise();
    });
  });
  const stderrText = (): string => (stderr.trim() === "" ? "it wrote nothing to stderr" : `its stderr ends: ${stderr.trim()}`);

  const stop = async (): Promise<void> => {
    if (exited !== null) return;
    if (process.platform === "win32" && child.pid !== undefined) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("error", () => child.kill());
      await exit;
      return;
    }
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    await exit;
    clearTimeout(killer);
  };

  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const deadline = performance.now() + timeout;
  for (;;) {
    if (startError !== null) {
      throw new Error(`runServer could not start ${named}: ${(startError as Error).message}`);
    }
    if (exited !== null) {
      const { code, signal } = exited as { code: number | null; signal: NodeJS.Signals | null };
      const how = signal === null ? `with code ${code}` : `on ${signal}`;
      throw new Error(`${named} exited ${how} before it accepted connections at ${where}; ${stderrText()}`);
    }
    if (await accepts(address.host, address.port)) return { url, stop };
    if (performance.now() >= deadline) {
      await stop();
      throw new Error(
        `${named} did not accept connections at ${where} within ${timeout} ms, so it was stopped; make it listen at ${url}, or pass a longer timeout; ${stderrText()}`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}
