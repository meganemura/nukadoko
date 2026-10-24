import { exec, execFile, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches, withoutChannelRecording } from "../src/context/channels.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { runCommand, withProcessRecording } from "../src/context/run-command.js";
import { createEmptyTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: what the channel patches (src/context/channels.ts)
// record inside a step's scope, and the http.jsonl lines and `observed`
// fields the collector (src/context/observed.ts) builds from them: a
// request through `fetch` and `node:http` with its bodies, redacted; a body
// that never ends, cut at the flush; the files the step's process wrote; the
// actions nukadoko cannot measure, each once; and nothing outside a step or
// from nukadoko's own I/O. A fetch wrapper (the shape msw and nock have)
// installed before or after the patches keeps working.

const SECRET = "s3cret-value";
const node = process.execPath;

let server: http.Server;
let base: string;

beforeAll(async () => {
  installChannelPatches();
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ got: body }));
    });
  });
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
  observed = createObservedCollector({
    outputDir: () => path.join(dir, "record"),
    unwatchedDirs: [path.join(dir, "state")],
    secrets: [{ name: "TOKEN", value: SECRET }],
  });
});

afterEach(async () => {
  await removeTempDir(dir);
});

function inStep<T>(fn: () => Promise<T>): Promise<T> {
  return withProcessRecording(observed.openRun([]), fn);
}

function httpLines(): Record<string, unknown>[] {
  try {
    return readFileSync(path.join(dir, "record", "http.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const sent = JSON.stringify({ token: SECRET });

describe("requests", () => {
  it("writes a fetch with both bodies, redacted, and counts it", async () => {
    await inStep(async () => {
      const response = await fetch(`${base}/echo?token=${SECRET}`, { method: "POST", body: sent });
      await response.text();
    });
    await observed.flush();
    const received = JSON.stringify({ got: sent });
    expect(httpLines()).toEqual([
      {
        method: "POST",
        url: `${base}/echo?token={{secret.TOKEN}}`,
        status: 200,
        duration_ms: expect.any(Number),
        via: "fetch",
        request_body: { text: '{"token":"{{secret.TOKEN}}"}', bytes: Buffer.byteLength(sent) },
        response_body: { text: '{"got":"{\\"token\\":\\"{{secret.TOKEN}}\\"}"}', bytes: Buffer.byteLength(received) },
      },
    ]);
    expect(observed.snapshot()).toEqual({ processes: null, http: 1, files: null, unmeasured: [] });
  });

  it("writes node:http request and get, and a refused connection with its error", async () => {
    await inStep(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(`${base}/echo`, { method: "PUT" }, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", reject);
        req.end("hello");
      });
      await new Promise<void>((resolve) => http.get(`${base}/echo`, (res) => res.resume().on("end", resolve)));
      await new Promise<void>((resolve) => http.get("http://127.0.0.1:1/refused").on("error", () => resolve()));
    });
    await observed.flush();
    const lines = httpLines().map(({ duration_ms: _ms, ...rest }) => rest);
    expect(lines).toEqual([
      {
        method: "PUT",
        url: `${base}/echo`,
        status: 200,
        via: "node:http",
        request_body: { text: "hello", bytes: 5 },
        response_body: { text: '{"got":"hello"}', bytes: 15 },
      },
      { method: "GET", url: `${base}/echo`, status: 200, via: "node:http", response_body: { text: '{"got":""}', bytes: 10 } },
      { method: "GET", url: "http://127.0.0.1:1/refused", status: 0, via: "node:http", error: expect.stringContaining("ECONNREFUSED") },
    ]);
    expect(observed.snapshot().http).toBe(3);
    // The agent's own connections carry recorded requests.
    expect(observed.snapshot().unmeasured).toEqual([]);
  });

  it("writes what arrived of a body that never ends, marked incomplete, once the flush stops waiting", async () => {
    await inStep(async () => {
      const response = await fetch(`${base}/stream`);
      const reader = response.body!.getReader();
      await reader.read();
      void reader.cancel();
    });
    const started = performance.now();
    await observed.flush(200);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(httpLines()).toEqual([
      expect.objectContaining({ url: `${base}/stream`, via: "fetch", response_body: { text: "data: one\n\n", truncated: true, bytes_read: 11, incomplete: true } }),
    ]);
  });

  it("records nothing outside a step, and nothing nukadoko itself sends inside one", async () => {
    await (await fetch(`${base}/echo`)).text();
    await inStep(async () => {
      await withoutChannelRecording(async () => (await fetch(`${base}/echo`)).text());
    });
    await observed.flush();
    expect(httpLines()).toEqual([]);
    expect(observed.snapshot().http).toBeNull();
  });
});

describe("files", () => {
  it("lists what the step's process wrote, with the content after the step, and leaves out the state directory", async () => {
    const work = path.join(dir, "work");
    await mkdir(work);
    writeFileSync(path.join(work, "existing.txt"), "before");
    await inStep(async () => {
      await writeFile(path.join(work, "new.txt"), `token=${SECRET}`);
      await appendFile(path.join(work, "existing.txt"), " and after");
      mkdirSync(path.join(work, "made"));
      // A directory that already exists changes nothing.
      await mkdir(work, { recursive: true });
      await writeFile(path.join(work, "brief.txt"), "gone soon");
      await writeFile(path.join(work, "brief.txt"), "still gone");
      (await import("node:fs")).rmSync(path.join(work, "brief.txt"));
      mkdirSync(path.join(dir, "state"), { recursive: true });
      writeFileSync(path.join(dir, "state", "record.json"), "{}");
    });
    expect(observed.snapshot().files).toEqual([
      {
        path: path.join(work, "existing.txt"),
        change: "changed",
        bytes: 16,
        content: { text: "before and after", bytes: 16 },
      },
      { path: `${path.join(work, "made")}/`, change: "added" },
      { path: path.join(work, "new.txt"), change: "added", bytes: 18, content: { text: "token={{secret.TOKEN}}", bytes: 18 } },
    ]);
  });
});

describe("unmeasured actions", () => {
  it("names a process started without runCommand by its program and argument count, a Worker, and a raw socket, each once", async () => {
    await inStep(async () => {
      await new Promise((resolve) => exec(`"${node}" -e 0`, resolve));
      await new Promise((resolve) => exec(`"${node}" -e 0`, resolve));
      await new Promise((resolve) => execFile(node, ["-e", "1"], resolve));
      spawnSync(node, ["-e", "2"]);
      const worker = new Worker("0", { eval: true });
      await new Promise((resolve) => worker.on("exit", resolve));
      const port = (server.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.end();
          resolve();
        });
      });
      // Measured, so not unmeasured.
      await runCommand(node, ["-e", "0"]);
    });
    const port = (server.address() as net.AddressInfo).port;
    expect(observed.snapshot().unmeasured).toEqual([
      { kind: "child_process", detail: "exec node with 2 arguments" },
      { kind: "child_process", detail: "execFile node with 2 arguments" },
      { kind: "child_process", detail: "spawnSync node with 2 arguments" },
      { kind: "worker_thread", detail: "new Worker inline code" },
      { kind: "socket", detail: `connect 127.0.0.1:${port}` },
    ]);
    expect(observed.snapshot().processes).toHaveLength(1);
  });

  it("keeps the promise form of exec and execFile, and marks a process started through it", async () => {
    const outputs = await inStep(async () => {
      const done = await promisify(execFile)(node, ["-e", "process.stdout.write('out')"]);
      const failed = await promisify(exec)(`"${node}" -e "process.stderr.write('err'); process.exit(3)"`).catch((error: unknown) => error);
      return { done, failed };
    });
    expect(outputs.done).toEqual({ stdout: "out", stderr: "" });
    expect(outputs.failed).toMatchObject({ code: 3, stdout: "", stderr: "err" });
    expect(observed.snapshot().unmeasured.map((entry) => entry.detail)).toEqual([
      "execFile node with 2 arguments",
      "exec node with 2 arguments",
    ]);
  });
});

describe("a fetch wrapper beside the patches", () => {
  it("keeps working when installed after them: a mocked request never reaches them, a passed-through one is recorded", async () => {
    const patched = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("http://mocked.test/") ? new Response("mocked") : patched(input, init)) as typeof fetch;
    try {
      const texts = await inStep(async () => [
        await (await fetch("http://mocked.test/a")).text(),
        await (await fetch(`${base}/echo`)).text(),
      ]);
      expect(texts).toEqual(["mocked", '{"got":""}']);
    } finally {
      globalThis.fetch = patched;
    }
    await observed.flush();
    expect(httpLines().map((line) => line.url)).toEqual([`${base}/echo`]);
  });

  it("keeps working when installed before them and after them: each mocked request is answered, and the earlier one's are recorded", () => {
    // A process of its own: the patches install once per process, so
    // "before" needs a process where they are not installed yet.
    const script = `
      const mock = (prefix, inner) => async (input, init) =>
        String(input).startsWith(prefix) ? new Response("mocked " + prefix) : inner(input, init);
      globalThis.fetch = mock("http://before.test/", globalThis.fetch);
      const { installChannelPatches } = await import(${JSON.stringify(path.join(repoRoot, "dist/context/channels.js"))});
      const { createObservedCollector } = await import(${JSON.stringify(path.join(repoRoot, "dist/context/observed.js"))});
      const { withProcessRecording } = await import(${JSON.stringify(path.join(repoRoot, "dist/context/run-command.js"))});
      installChannelPatches();
      globalThis.fetch = mock("http://after.test/", globalThis.fetch);
      const out = ${JSON.stringify(path.join(dir, "child"))};
      const observed = createObservedCollector({ outputDir: () => out });
      const texts = await withProcessRecording(observed.openRun([]), async () => [
        await (await fetch("http://before.test/x")).text(),
        await (await fetch("http://after.test/y")).text(),
      ]);
      await observed.flush();
      const { readFileSync } = await import("node:fs");
      const lines = readFileSync(out + "/http.jsonl", "utf8").trim().split("\\n").map((line) => JSON.parse(line));
      console.log(JSON.stringify({ texts, urls: lines.map((line) => line.url), bodies: lines.map((line) => line.response_body.text), http: observed.snapshot().http }));
    `;
    const result = spawnSync(node, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      texts: ["mocked http://before.test/", "mocked http://after.test/"],
      urls: ["http://before.test/x"],
      bodies: ["mocked http://before.test/"],
      http: 1,
    });
  });
});
