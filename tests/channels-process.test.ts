import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: what the channel patches (src/context/channels.ts) do to
// a whole process, measured in a process of their own against dist/: the
// patches install once per process, so a test that compares a builtin
// before and after them, measures the process's memory, or needs its
// stdout to be a pipe and an IPC channel to exist, cannot share the test
// worker. Three things: the child_process builtins keep the originals'
// names, lengths, promise forms, and synchronous throws; a body the step
// sends or receives through fetch costs at most a window of memory to
// record, however long it is; and the step's own console output, stdio
// pipes, IPC messages, runCommand's stdin, and recorded requests never
// read as an unmeasured connection, while a connection opened before the
// step that the step writes to does.

const node = process.execPath;
const dist = (file: string): string => JSON.stringify(path.join(repoRoot, "dist/context", file));

const imports = `
  const { installChannelPatches } = await import(${dist("channels.js")});
  const { createObservedCollector } = await import(${dist("observed.js")});
  const { withProcessRecording, runCommand } = await import(${dist("run-command.js")});
`;

let dir: string;

beforeEach(async () => {
  dir = await createEmptyTempDir();
});

afterEach(async () => {
  await removeTempDir(dir);
});

function runScript(script: string, args: readonly string[] = []): unknown {
  const result = spawnSync(node, [...args, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 120_000 });
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

describe("the child_process builtins", () => {
  it("keep the originals' names, lengths, promise forms, and synchronous throws, outside a step and inside one", () => {
    const script = `
      import childProcess, { exec as namedExec } from "node:child_process";
      import { promisify } from "node:util";
      const NAMES = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
      const shape = (fn) => (typeof fn === "function" ? { name: fn.name, length: fn.length } : null);
      const shapes = () => Object.fromEntries(NAMES.map((name) => [name, { fn: shape(childProcess[name]), custom: shape(childProcess[name][promisify.custom]) }]));
      const outcome = (fn) => {
        try {
          const result = fn();
          if (result && typeof result.then === "function") {
            result.catch(() => undefined);
            return "returned a promise";
          }
          return "returned";
        } catch (error) {
          return "threw " + (error.code ?? error.name);
        }
      };
      const behaviour = () => ({
        promisifiedExecFile: outcome(() => promisify(childProcess.execFile)(123)),
        promisifiedExec: outcome(() => promisify(childProcess.exec)(123)),
        spawn: outcome(() => childProcess.spawn(123)),
        execFileSync: outcome(() => childProcess.execFileSync(123)),
        exec: outcome(() => childProcess.exec(123)),
      });
      const original = { exec: childProcess.exec, shapes: shapes(), behaviour: behaviour() };
      ${imports}
      installChannelPatches();
      const collector = createObservedCollector({ outputDir: () => ${JSON.stringify(path.join(dir, "out"))} });
      const inside = await withProcessRecording(collector.openRun([]), async () => ({
        behaviour: behaviour(),
        resolved: await promisify(childProcess.execFile)(process.execPath, ["-e", "process.stdout.write('hi')"]),
        rejected: await promisify(childProcess.exec)(JSON.stringify(process.execPath) + " -e \\"process.exit(3)\\"").catch((error) => ({ code: error.code, stdout: error.stdout })),
      }));
      console.log(JSON.stringify({
        replaced: childProcess.exec !== original.exec,
        named: shape(namedExec),
        original: { shapes: original.shapes, behaviour: original.behaviour },
        outside: { shapes: shapes(), behaviour: behaviour() },
        inside,
        unmeasured: collector.snapshot().unmeasured,
      }));
    `;
    const result = runScript(script) as Record<string, any>;
    // The patches replaced the functions, so the comparison below is of
    // the wrappers, not of the originals with themselves.
    expect(result.replaced).toBe(true);
    expect(result.original.behaviour.promisifiedExecFile).toMatch(/^threw /);
    expect(result.outside).toEqual(result.original);
    expect(result.named).toEqual(result.original.shapes.exec.fn);
    expect(result.inside).toEqual({
      behaviour: result.original.behaviour,
      resolved: { stdout: "hi", stderr: "" },
      rejected: { code: 3, stdout: "" },
    });
    // A call that threw on its arguments started nothing, so names nothing.
    expect(result.unmeasured).toEqual([
      { kind: "child_process", detail: "execFile node with 2 arguments" },
      { kind: "child_process", detail: "exec node with 2 arguments" },
    ]);
  });
});

describe("the memory a fetch body costs to record", () => {
  // 128 MiB, streamed in 1 MiB chunks and never held whole by either side.
  const MIB = 2 ** 20;
  const TOTAL = 128;

  it("stays within a few MiB for a response the step holds unread and for a streamed upload", () => {
    const script = `
      import http from "node:http";
      ${imports}
      installChannelPatches();
      const MIB = ${MIB};
      const TOTAL = ${TOTAL};
      const chunk = Buffer.alloc(MIB, 97);
      const server = http.createServer((req, res) => {
        if (req.url === "/download") {
          let sent = 0;
          const pump = () => {
            while (sent < TOTAL) {
              sent += 1;
              if (!res.write(chunk)) return void res.once("drain", pump);
            }
            res.end();
          };
          return pump();
        }
        if (req.url === "/upload-slow") {
          // Reads nothing for a while, so the upload is pulled only as fast
          // as the connection takes it.
          req.pause();
          return void setTimeout(() => req.resume().on("end", () => res.end("ok")), 2000);
        }
        req.resume().on("end", () => res.end("ok"));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = "http://127.0.0.1:" + server.address().port;
      const settle = async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        globalThis.gc();
        return Math.round(process.memoryUsage().arrayBuffers / MIB);
      };
      const collector = createObservedCollector({ outputDir: () => ${JSON.stringify(path.join(dir, "out"))} });
      const inStep = (fn) => withProcessRecording(collector.openRun([]), fn);

      const response = await inStep(() => fetch(base + "/download"));
      const heldUnread = await settle(1500);
      await response.body.cancel();

      let pulled = 0;
      const body = new ReadableStream({ pull(controller) { if (pulled++ < TOTAL) controller.enqueue(new Uint8Array(MIB)); else controller.close(); } });
      const upload = inStep(() => fetch(base + "/upload-slow", { method: "POST", body, duplex: "half" }));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const pulledWhileSlow = pulled;
      await (await upload).text();

      await collector.flush();
      server.closeAllConnections();
      server.close();
      console.log(JSON.stringify({ heldUnread, pulledWhileSlow, http: collector.snapshot().http }));
    `;
    const result = runScript(script, ["--expose-gc"]) as Record<string, number>;
    expect(result.heldUnread).toBeLessThan(16);
    expect(result.pulledWhileSlow).toBeLessThan(32);
    expect(result.http).toBe(2);
  }, 120_000);

  it("keeps nothing of a finished request but its count, in its step and after its step ended", () => {
    // Each body is 40 KB, past the 32 KiB window, so a request's line
    // holds a window's worth of memory until the recorder lets it go. The
    // same requests sent outside a step are the baseline. Holding every
    // window until a flush that never comes measured 131 MB for the 2000
    // requests in a step and 98 MB for the 1500 late ones.
    const script = `
      import http from "node:http";
      ${imports}
      installChannelPatches();
      const MIB = ${MIB};
      const body = "x".repeat(40000);
      const server = http.createServer((req, res) => res.end(body));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = "http://127.0.0.1:" + server.address().port;
      const retained = async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        globalThis.gc();
        globalThis.gc();
        return process.memoryUsage().arrayBuffers / MIB;
      };
      const poll = async (count) => {
        for (let i = 0; i < count; i += 1) await (await fetch(base + "/x")).text();
      };
      const collector = createObservedCollector({ outputDir: () => ${JSON.stringify(path.join(dir, "out"))} });

      await poll(2000);
      const outside = await retained();

      let inStep;
      await withProcessRecording(collector.openRun([]), async () => {
        await poll(2000);
        inStep = await retained();
      });
      await collector.flush();
      collector.snapshot();
      collector.close();

      // Left behind by the step, after its record was written.
      const run = collector.openRun([]);
      let leave;
      const left = new Promise((resolve) => (leave = resolve));
      const lateDone = withProcessRecording(run, async () => {
        await left;
        await poll(1500);
      });
      collector.reset();
      leave();
      await lateDone;
      const late = await retained();
      server.closeAllConnections();
      server.close();
      console.log(JSON.stringify({ outside, inStep, late }));
    `;
    const result = runScript(script, ["--expose-gc"]) as { outside: number; inStep: number; late: number };
    expect(result.inStep - result.outside).toBeLessThan(16);
    expect(result.late - result.outside).toBeLessThan(16);
  }, 120_000);

    it("reads only the start of a Blob body to record it, however large the Blob is", () => {
    const sparse = path.join(dir, "big.bin");
    // Counts every byte any reader takes from the Blob, through each of its
    // reading methods and those of any slice. undici reads the whole Blob to
    // send it, so the send outside a step is the baseline, and the record
    // adds only what it read itself.
    const script = `
      import fs from "node:fs";
      import http from "node:http";
      ${imports}
      installChannelPatches();
      const MIB = ${MIB};
      const fd = fs.openSync(${JSON.stringify(sparse)}, "w");
      fs.ftruncateSync(fd, ${TOTAL} * MIB);
      fs.closeSync(fd);
      let read = 0;
      class CountingBlob extends Blob {
        slice(...args) { return new CountingBlob([super.slice(...args)]); }
        async arrayBuffer() { const bytes = await super.arrayBuffer(); read += bytes.byteLength; return bytes; }
        async bytes() { const bytes = await super.bytes(); read += bytes.byteLength; return bytes; }
        async text() { const text = await super.text(); read += Buffer.byteLength(text); return text; }
        stream() { return super.stream().pipeThrough(new TransformStream({ transform(chunk, controller) { read += chunk.byteLength; controller.enqueue(chunk); } })); }
      }
      const blob = new CountingBlob([await fs.openAsBlob(${JSON.stringify(sparse)})]);
      const server = http.createServer((req, res) => req.resume().on("end", () => res.end("ok")));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = "http://127.0.0.1:" + server.address().port;
      const collector = createObservedCollector({ outputDir: () => ${JSON.stringify(path.join(dir, "out"))} });
      const sendBlob = async () => (await fetch(base + "/upload", { method: "POST", body: blob })).text();
      read = 0;
      await sendBlob();
      const outside = read;
      read = 0;
      await withProcessRecording(collector.openRun([]), sendBlob);
      const inside = read;
      await collector.flush();
      server.close();
      console.log(JSON.stringify({ size: blob.size, outside, inside, http: collector.snapshot().http }));
    `;
    const result = runScript(script) as { size: number; outside: number; inside: number; http: number };
    expect(result.outside).toBe(result.size);
    // Reading the whole Blob for the record would add all of its size.
    expect(result.inside - result.outside).toBeGreaterThan(0);
    expect(result.inside - result.outside).toBeLessThan(MIB);
    expect(result.http).toBe(1);
  }, 120_000);
});

describe("connections the step did not open", () => {
  it("never names console output, stdio pipes, IPC, runCommand's stdin, or a recorded request, and names a connection opened before the step once it is written to", async () => {
    const script = `
      import http from "node:http";
      import net from "node:net";
      ${imports}
      installChannelPatches();
      const server = http.createServer((req, res) => req.resume().on("end", () => res.end("ok")));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const base = "http://127.0.0.1:" + port;
      const before = await new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
        socket.on("data", () => undefined);
      });
      const quiet = createObservedCollector({ outputDir: () => ${JSON.stringify(path.join(dir, "quiet"))} });
      await withProcessRecording(quiet.openRun([]), async () => {
        console.log("to stdout");
        console.error("to stderr");
        process.stdout.write("written to stdout\\n");
        process.stderr.write("written to stderr\\n");
        process.send({ progress: "over the IPC channel" });
        await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "stdin text" });
        await (await fetch(base + "/a")).text();
        await new Promise((resolve) => http.get(base + "/b", (res) => res.resume().on("end", resolve)));
      });
      await quiet.flush();
      const written = createObservedCollector({ outputDir: () => ${JSON.stringify(path.join(dir, "written"))} });
      await withProcessRecording(written.openRun([]), async () => {
        before.write("GET / HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n");
      });
      before.destroy();
      server.closeAllConnections();
      server.close();
      process.send({ port, quiet: quiet.snapshot(), written: written.snapshot().unmeasured });
      process.disconnect();
    `;
    const child = spawn(node, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
    const messages: Record<string, any>[] = [];
    child.on("message", (message) => messages.push(message as Record<string, any>));
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    child.stdout!.resume();
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(stderr).toBe("to stderr\nwritten to stderr\n");
    expect(code).toBe(0);
    const result = messages.at(-1)!;
    expect(result.quiet).toMatchObject({ http: 2, unmeasured: [] });
    expect(result.quiet.processes).toHaveLength(1);
    expect(result.written).toEqual([{ kind: "socket", detail: `write to 127.0.0.1:${result.port}, a connection opened before the step` }]);
  });
});
