import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { layerProgram, programSchema, type ProgramInput } from "../src/config/program-schema.js";
import { createWorldStarter, type StartedWorld } from "../src/program/world.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: a world's `setup` and `url` function, which run in
// nukadoko's own process (src/program/in-process-output.ts): what their
// own async work prints reaches the world's program.log and the progress
// sink, redacted, and what any other code prints meanwhile does not. One
// past its limit, or running when the start is aborted, is abandoned: its
// capture ends with a line that says so, its `signal` is aborted, and what
// it prints later goes where it always goes, redacted, never into the log.

let rootDir: string;
let runDir: string;
const started: StartedWorld[] = [];
const intervals: NodeJS.Timeout[] = [];

// What reaches the real stdout, through a spy installed before any world
// starts, so nukadoko's wrapper forwards to it.
let stdoutSeen = "";
let realWrite: typeof process.stdout.write;
beforeAll(() => {
  realWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stdoutSeen += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return (realWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
});
afterAll(() => {
  process.stdout.write = realWrite;
});

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), "nukadoko-in-process-"));
  runDir = path.join(rootDir, ".nukadoko", "runs", "r1");
  stdoutSeen = "";
});

afterEach(async () => {
  for (const interval of intervals.splice(0)) clearInterval(interval);
  for (const world of started.splice(0)) await world.stop();
  rmSync(rootDir, { recursive: true, force: true });
});

function starter(progress = createCaptureSink()) {
  return createWorldStarter({
    rootDir,
    worldDir: (name) => path.join(runDir, "worlds", name),
    recordPath: (absolutePath) => path.relative(runDir, absolutePath).split(path.sep).join("/"),
    displayPath: (absolutePath) => path.relative(rootDir, absolutePath).split(path.sep).join("/"),
    progress,
  });
}

function recipe(input: ProgramInput) {
  return layerProgram(programSchema.parse(input), undefined);
}

function logOf(name: string): string {
  return readFileSync(path.join(runDir, "worlds", name, "program.log"), "utf8");
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a setup past its limit", () => {
  it("captures only its own writes, while another world starts beside it and other code prints", async () => {
    const progress = createCaptureSink();
    const worlds = starter(progress);
    const hang = worlds.start(
      "hang",
      recipe({ env: { TOKEN: "{token}" }, setup: { run: () => new Promise(() => {}), timeout_ms: 400 } }),
      [],
    );
    const ok = worlds.start(
      "ok",
      recipe({
        setup: async () => {
          await delay(50);
          console.log("ok world seeding");
        },
      }),
      [],
    );
    await delay(100);
    console.log("OUTSIDE-CONSOLE");
    process.stdout.write("OUTSIDE-STDOUT\n");
    const [hung, done] = await Promise.all([hang, ok]);
    if (done.ok) started.push(done);
    expect(done.ok).toBe(true);
    expect(hung.ok).toBe(false);

    const hangLog = logOf("hang");
    expect(hangLog).not.toContain("ok world seeding");
    expect(hangLog).not.toContain("world ok:");
    expect(hangLog).not.toContain("OUTSIDE");
    expect(hangLog.trimEnd().split("\n").at(-1)).toBe("# setup was abandoned at its limit (400 ms); it stops only if it honours its signal");
    expect(logOf("ok")).toContain("# setup\nok world seeding\n");
    expect(stdoutSeen).toContain("OUTSIDE-STDOUT\n");
  });

  it("aborts its signal, and what it prints afterwards reaches the stream redacted, never the log", async () => {
    let signal: AbortSignal | undefined;
    const world = await starter().start(
      "default",
      recipe({
        env: { TOKEN: "{token}" },
        setup: {
          run: (given) => {
            signal = given.signal;
            process.stdout.write(`seeding with ${given.env.TOKEN}\n`);
            intervals.push(setInterval(() => process.stdout.write(`still seeding with ${given.env.TOKEN}\n`), 50));
            return new Promise(() => {});
          },
          timeout_ms: 300,
        },
      }),
      [],
    );
    expect(world.ok).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as Error).message).toBe("setup was abandoned at its limit (300 ms)");
    const logAtFailure = logOf("default");
    const lines = logAtFailure.trimEnd().split("\n");
    expect(lines.slice(0, 2)).toEqual(["# setup", "seeding with {{secret.WORLD_TOKEN}}"]);
    expect(new Set(lines.slice(2, -1))).toEqual(new Set(["still seeding with {{secret.WORLD_TOKEN}}"]));
    expect(logAtFailure.trimEnd().split("\n").at(-1)).toBe("# setup was abandoned at its limit (300 ms); it stops only if it honours its signal");

    stdoutSeen = "";
    await delay(300);
    expect(logOf("default")).toBe(logAtFailure);
    expect(stdoutSeen).toContain("still seeding with {{secret.WORLD_TOKEN}}\n");
    expect(stdoutSeen).not.toMatch(/still seeding with [0-9a-f]{32}/);
  });

  it("is abandoned when the start is aborted, and one that honours its signal stops", async () => {
    const abort = new AbortController();
    let stopped = false;
    setTimeout(() => abort.abort(), 200);
    const world = await starter().start(
      "default",
      recipe({
        setup: (given) =>
          new Promise<void>((_, reject) => {
            const interval = setInterval(() => console.log("seeding"), 50);
            intervals.push(interval);
            given.signal.addEventListener("abort", () => {
              clearInterval(interval);
              stopped = true;
              reject(given.signal.reason);
            });
          }),
      }),
      [],
      abort.signal,
    );
    expect(world.ok ? null : world.aborted).toBe(true);
    expect(stopped).toBe(true);
    expect(logOf("default").trimEnd().split("\n").at(-1)).toBe("# setup was abandoned when the start was stopped; it stops only if it honours its signal");
  });
});

describe("a url function past its limit", () => {
  it("is abandoned with its signal, and what it prints afterwards stays out of the world's log", async () => {
    let signal: AbortSignal | undefined;
    const world = await starter().start(
      "default",
      recipe({
        url: {
          resolve: (place) => {
            signal = place.signal;
            intervals.push(setInterval(() => console.log("still resolving"), 50));
            return new Promise<string>(() => {});
          },
          timeout_ms: 250,
        },
      }),
      [],
    );
    expect(world.ok ? null : world.message).toMatch(
      /^the program did not start for world default: the url function did not finish within 250 ms \(timeout_ms\)\. The end of \.nukadoko\/runs\/r1\/worlds\/default\/program\.log:\n/,
    );
    expect(signal?.aborted).toBe(true);
    const logAtFailure = logOf("default");
    expect(logAtFailure.trimEnd().split("\n").at(-1)).toBe("# the url function was abandoned at its limit (250 ms); it stops only if it honours its signal");
    await delay(250);
    expect(logOf("default")).toBe(logAtFailure);
  });
});
