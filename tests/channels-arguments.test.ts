import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches } from "../src/context/channels.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a patched call given a path or an argument the recorder
// cannot read (src/context/channels.ts, src/context/step-files.ts). The
// patches read their arguments before the original does, and the recorder
// reads each written path's identity inside the call and again at the
// step's end, so any of those reads could throw into the step's code or
// end the run. Each case compares the error inside a step with the error
// outside one, where no patch records, and checks what the record says.

let server: http.Server;
let base: string;

beforeAll(async () => {
  installChannelPatches();
  server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

let dir: string;
let observed: ObservedCollector;

beforeEach(async () => {
  dir = await createEmptyTempDir();
  observed = createObservedCollector({ outputDir: () => path.join(dir, "record"), unwatchedDirs: [path.join(dir, "state")] });
});

afterEach(async () => {
  await removeTempDir(dir);
});

function inStep<T>(fn: () => Promise<T>): Promise<T> {
  return withProcessRecording(observed.openRun([]), fn);
}

type Outcome = { readonly threw: string } | { readonly rejected: string } | { readonly called: string } | "returned";

function shape(error: unknown): string {
  const { code, syscall } = error as NodeJS.ErrnoException;
  return [(error as Error).constructor.name, code, syscall].filter((part) => part !== undefined).join(" ");
}

/** How a call ends: thrown synchronously, rejected, or reported to its
 * callback, with the error's class, code, and syscall. */
async function outcomeOf(call: (callback: (error: unknown) => void) => unknown): Promise<Outcome> {
  let reported: ((error: unknown) => void) | undefined;
  const callback = new Promise<unknown>((resolve) => (reported = resolve));
  let returned: unknown;
  try {
    returned = call((error) => reported!(error));
  } catch (error) {
    return { threw: shape(error) };
  }
  if (returned instanceof Promise) {
    return returned.then(
      () => "returned",
      (error: unknown) => ({ rejected: shape(error) }),
    );
  }
  const error = await Promise.race([callback, new Promise((resolve) => setTimeout(() => resolve(undefined), 200))]);
  return error === undefined || error === null ? "returned" : { called: shape(error) };
}

describe("a write whose path the recorder cannot inspect", () => {
  it("ends the step's call with the original's error, in every form, and leaves no trace for a path under a file", async () => {
    const plain = path.join(dir, "plain");
    fs.writeFileSync(plain, "x");
    const under = path.join(plain, "child.txt");
    const calls = [
      (callback: (error: unknown) => void) => fs.writeFile(under, "y", callback),
      () => fs.promises.writeFile(under, "y"),
      () => fs.writeFileSync(under, "y"),
      () => fs.mkdirSync(path.join(under, "deeper"), { recursive: true }),
    ];
    const outside = await Promise.all(calls.map((call) => outcomeOf(call)));
    const inside = await inStep(() => Promise.all(calls.map((call) => outcomeOf(call))));
    expect(outside).toEqual([{ called: "Error ENOTDIR open" }, { rejected: "Error ENOTDIR open" }, { threw: "Error ENOTDIR open" }, { threw: "Error ENOTDIR mkdir" }]);
    expect(inside).toEqual(outside);
    await observed.flush();
    // ENOTDIR says the path does not exist: nothing changed, and nothing
    // went unmeasured.
    expect(observed.snapshot()).toEqual({ processes: null, http: null, files: null, unmeasured: [] });
  });

  it("names a path whose identity cannot be read as unmeasured, with the error's code", async () => {
    fs.symlinkSync(path.join(dir, "b"), path.join(dir, "a"));
    fs.symlinkSync(path.join(dir, "a"), path.join(dir, "b"));
    const looped = path.join(dir, "a", "x.txt");
    const outside = await outcomeOf(() => fs.writeFileSync(looped, "y"));
    const inside = await inStep(() => outcomeOf(() => fs.writeFileSync(looped, "y")));
    expect(outside).toEqual({ threw: "Error ELOOP open" });
    expect(inside).toEqual(outside);
    await observed.flush();
    expect(observed.snapshot()).toEqual({
      processes: null,
      http: null,
      files: null,
      unmeasured: [{ kind: "files", detail: `${looped} could not be inspected: ELOOP` }],
    });
  });

  it("measures a written path whose directory became a file before the step ended", async () => {
    const replaced = path.join(dir, "d");
    await inStep(async () => {
      fs.mkdirSync(replaced);
      fs.writeFileSync(path.join(replaced, "f"), "1");
      fs.rmSync(replaced, { recursive: true });
      fs.writeFileSync(replaced, "now a file");
    });
    await observed.flush();
    expect(observed.snapshot()).toEqual({
      processes: null,
      http: null,
      files: [{ path: replaced, change: "added", bytes: 10, content: { text: "now a file", bytes: 10 } }],
      unmeasured: [],
    });
  });

  it("leaves a file URL with a host to the original, which rejects the promise form instead of throwing", async () => {
    const call = (): Promise<void> => fs.promises.writeFile(new URL("file://elsewhere/x.txt"), "y");
    const outside = await outcomeOf(call);
    expect(outside).toEqual({ rejected: "TypeError ERR_INVALID_FILE_URL_HOST" });
    expect(await inStep(() => outcomeOf(call))).toEqual(outside);
  });
});

describe("an argument the builtin rejects", () => {
  it("gets the builtin's own error inside a step, and names nothing, since nothing started", async () => {
    const calls = [
      () => new Worker(Symbol("script") as unknown as string),
      () => new net.Socket().connect({ host: Symbol("host") as unknown as string, port: 1 }),
    ];
    const outside = await Promise.all(calls.map((call) => outcomeOf(call)));
    expect(outside).toEqual([{ threw: "TypeError ERR_INVALID_ARG_TYPE" }, { threw: "TypeError ERR_INVALID_ARG_TYPE" }]);
    expect(await inStep(() => Promise.all(calls.map((call) => outcomeOf(call))))).toEqual(outside);
    await observed.flush();
    expect(observed.snapshot().unmeasured).toEqual([]);
  });

  it("writes a request's line when the step emits an error that has no text, and lets the emit return", async () => {
    const emitted = await inStep(async () => {
      const req = http.get(`${base}/x`);
      req.on("error", () => undefined);
      const returned = req.emit("error", {
        toString(): string {
          throw new Error("no text");
        },
      });
      req.destroy();
      return returned;
    });
    expect(emitted).toBe(true);
    await observed.flush();
    const lines = fs
      .readFileSync(path.join(dir, "record", "http.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ status: 0, error: "a thrown value that has no text" })]);
  });
});
