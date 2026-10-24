import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches, withoutChannelRecording } from "../src/context/channels.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the request shapes the plain cases in channels.test.ts
// do not reach, each against src/context/channels.ts and the collector in
// src/context/observed.ts: an upgrade and a CONNECT (the handshake is a
// line with its real status, what follows is one unmeasured socket, and
// the flush does not wait for it); a proxy agent that opens its socket in
// a microtask; a request with no response when the flush ends; a fetch
// that throws before it sends; HEAD and 204, which have no body; a body
// the step asked for as base64 or hex; and a connection opened before the
// step that the step writes to.

const SECRET = "s3cret-value";

let server: http.Server;
let port: number;
let base: string;
// Requests to /slow are held here until a test lets them go.
const held: http.ServerResponse[] = [];
// An upgraded or tunnelled connection leaves the server's own list, so
// closeAllConnections does not reach it.
const detached: net.Socket[] = [];

beforeAll(async () => {
  installChannelPatches();
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/slow") {
        held.push(res);
        return;
      }
      if (req.url === "/empty") {
        res.writeHead(204).end();
        return;
      }
      res.setHeader("content-type", "text/plain");
      res.end(`token=${SECRET}`);
    });
  });
  server.on("upgrade", (_req, socket: net.Socket) => {
    detached.push(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: chat\r\nConnection: Upgrade\r\n\r\n");
    // Echo, and never close: the flush must not wait for this connection.
    socket.on("data", (chunk) => socket.write(chunk));
  });
  server.on("connect", (_req, socket: net.Socket) => {
    detached.push(socket);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const socket of detached) socket.destroy();
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
  for (const res of held.splice(0)) res.end("late");
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

function withoutDuration(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.map(({ duration_ms: _ms, ...rest }) => rest);
}

function get(url: string, options: http.RequestOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, options, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += String(chunk)));
        res.on("end", () => resolve(text));
      })
      .on("error", reject);
  });
}

describe("an upgrade and a CONNECT", () => {
  it("writes the upgrade's handshake with status 101, marks what the connection carries after it, and does not wait for it", async () => {
    const socket = await inStep(
      () =>
        new Promise<net.Socket>((resolve, reject) => {
          const req = http.request(`${base}/chat`, { headers: { Connection: "Upgrade", Upgrade: "chat" } });
          req.on("upgrade", (_res, upgraded: net.Socket) => {
            upgraded.write("hello");
            resolve(upgraded);
          });
          req.on("error", reject);
          req.end();
        }),
    );
    const started = performance.now();
    await observed.flush(5000);
    expect(performance.now() - started).toBeLessThan(1000);
    socket.destroy();
    expect(withoutDuration(httpLines())).toEqual([{ method: "GET", url: `${base}/chat`, status: 101, via: "node:http" }]);
    expect(observed.snapshot()).toMatchObject({ http: 1, unmeasured: [{ kind: "socket", detail: `traffic after the upgrade of ${base}/chat` }] });
  });

  it("writes a CONNECT with the tunnel's status and its target, and marks the tunnel's traffic", async () => {
    const socket = await inStep(
      () =>
        new Promise<net.Socket>((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: "example.test:443" });
          req.on("connect", (_res, tunnel: net.Socket) => {
            tunnel.write("through");
            resolve(tunnel);
          });
          req.on("error", reject);
          req.end();
        }),
    );
    await observed.flush(5000);
    socket.destroy();
    expect(withoutDuration(httpLines())).toEqual([{ method: "CONNECT", url: "example.test:443", status: 200, via: "node:http" }]);
    expect(observed.snapshot().unmeasured).toEqual([{ kind: "socket", detail: "traffic through the CONNECT tunnel to example.test:443" }]);
  });
});

describe("a socket a request was given later", () => {
  it("counts a socket a proxy agent opened in a microtask as the request's, not as an unmeasured connection", async () => {
    // The agent-base 7 shape (https-proxy-agent 7, proxy-agent 6): the
    // socket is connected in a microtask after createSocket returned, so
    // it connects outside http.request's own call.
    class AsyncAgent extends http.Agent {
      createSocket(_req: http.ClientRequest, options: { port?: number; host?: string }, callback: (error: Error | null, socket?: net.Socket) => void): void {
        Promise.resolve()
          .then(() => net.connect(options.port!, options.host))
          .then((socket) => callback(null, socket), callback);
      }
    }
    await inStep(() => get(`${base}/x`, { agent: new AsyncAgent() }));
    await observed.flush();
    expect(observed.snapshot()).toMatchObject({ http: 1, unmeasured: [] });
  });
});

describe("a request with no response when the flush ends", () => {
  it("is written with status 0 and the no-response error, from node:http and from fetch alike", async () => {
    await inStep(async () => {
      http.get(`${base}/slow`).on("error", () => undefined);
      void fetch(`${base}/slow`).catch(() => undefined);
      while (held.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await observed.flush(200);
    const lines = withoutDuration(httpLines());
    const error = "no response within 200 ms of the step's end";
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        { method: "GET", url: `${base}/slow`, status: 0, via: "node:http", error },
        { method: "GET", url: `${base}/slow`, status: 0, via: "fetch", error },
      ]),
    );
    // The response that arrives after the line was written changes nothing.
    for (const res of held.splice(0)) res.end("late");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(httpLines()).toHaveLength(2);
  });
});

describe("a fetch that throws before it sends", () => {
  it("gives the caller exactly the error fetch gives outside a step, and writes a line with it", async () => {
    const used = async (): Promise<unknown> => {
      const request = new Request(`${base}/x`, { method: "POST", body: "once" });
      await request.text();
      return fetch(request).catch((error: unknown) => error);
    };
    const getWithBody = (): Promise<unknown> => {
      const form = new FormData();
      form.set("a", "b");
      return fetch(`${base}/x`, { method: "GET", body: form }).catch((error: unknown) => error);
    };
    const outside = [await used(), await getWithBody()] as Error[];
    const inside = (await inStep(async () => [await used(), await getWithBody()])) as Error[];
    await observed.flush();
    expect(inside.map((error) => [error.constructor, error.message])).toEqual(outside.map((error) => [error.constructor, error.message]));
    const lines = withoutDuration(httpLines());
    expect(lines).toEqual([
      { method: "POST", url: `${base}/x`, status: 0, via: "fetch", error: outside[0]!.message },
      { method: "GET", url: `${base}/x`, status: 0, via: "fetch", error: outside[1]!.message },
    ]);
    expect(observed.snapshot().http).toBe(lines.length);
  });
});

describe("a response with no body", () => {
  it("has no response_body for HEAD and 204, from node:http and from fetch alike", async () => {
    await inStep(async () => {
      await new Promise<void>((resolve, reject) => {
        http.request(`${base}/x`, { method: "HEAD" }, (res) => res.resume().on("end", resolve)).on("error", reject).end();
      });
      await get(`${base}/empty`);
      await (await fetch(`${base}/x`, { method: "HEAD" })).text();
      await (await fetch(`${base}/empty`)).text();
    });
    await observed.flush();
    expect(withoutDuration(httpLines())).toEqual([
      { method: "HEAD", url: `${base}/x`, status: 200, via: "node:http" },
      { method: "GET", url: `${base}/empty`, status: 204, via: "node:http" },
      { method: "HEAD", url: `${base}/x`, status: 200, via: "fetch" },
      { method: "GET", url: `${base}/empty`, status: 204, via: "fetch" },
    ]);
  });
});

describe("a body the step asked for as strings", () => {
  it("is redacted after setEncoding as if it were bytes, and so is a request written as base64", async () => {
    const texts = await inStep(async () => {
      const read = (encoding: BufferEncoding): Promise<string> =>
        new Promise((resolve, reject) => {
          const req = http.request(`${base}/x`, { method: "POST" }, (res) => {
            res.setEncoding(encoding);
            let text = "";
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => resolve(text));
          });
          req.on("error", reject);
          req.end(Buffer.from(`sent=${SECRET}`).toString("base64"), "base64");
        });
      return [await read("base64"), await read("hex")];
    });
    expect(Buffer.from(texts[0]!, "base64").toString()).toBe(`token=${SECRET}`);
    expect(Buffer.from(texts[1]!, "hex").toString()).toBe(`token=${SECRET}`);
    await observed.flush();
    const bodies = httpLines().map((line) => [line.request_body, line.response_body]);
    const sentBytes = Buffer.byteLength(`sent=${SECRET}`);
    const gotBytes = Buffer.byteLength(`token=${SECRET}`);
    expect(bodies).toEqual([
      [{ text: "sent={{secret.TOKEN}}", bytes: sentBytes }, { text: "token={{secret.TOKEN}}", bytes: gotBytes }],
      [{ text: "sent={{secret.TOKEN}}", bytes: sentBytes }, { text: "token={{secret.TOKEN}}", bytes: gotBytes }],
    ]);
  });
});

describe("a connection opened before the step", () => {
  let raw: http.Server;
  let rawPort: number;
  beforeAll(async () => {
    raw = http.createServer((req, res) => req.resume().on("end", () => res.end("ok")));
    raw.keepAliveTimeout = 10_000;
    await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
    rawPort = (raw.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    raw.closeAllConnections();
    await new Promise((resolve) => raw.close(resolve));
  });

  function connected(): Promise<net.Socket> {
    return new Promise((resolve) => {
      const socket = net.connect(rawPort, "127.0.0.1", () => resolve(socket));
      socket.on("data", () => undefined);
    });
  }

  it("is named once, by its address, when the step writes to it", async () => {
    const socket = await connected();
    await inStep(async () => {
      socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
      socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    });
    socket.destroy();
    expect(observed.snapshot().unmeasured).toEqual([
      { kind: "socket", detail: `write to 127.0.0.1:${rawPort}, a connection opened before the step` },
    ]);
  });

  it("is not named when nukadoko opened it, or when it carries a recorded request again", async () => {
    const own = await withoutChannelRecording(() => connected());
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await get(`http://127.0.0.1:${rawPort}/`, { agent });
    await (await fetch(`http://127.0.0.1:${rawPort}/`)).text();
    await inStep(async () => {
      own.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
      // The kept-alive sockets of the two requests above, reused.
      await get(`http://127.0.0.1:${rawPort}/`, { agent });
      await (await fetch(`http://127.0.0.1:${rawPort}/`)).text();
    });
    own.destroy();
    agent.destroy();
    await observed.flush();
    expect(observed.snapshot()).toMatchObject({ http: 2, unmeasured: [] });
  });
});
