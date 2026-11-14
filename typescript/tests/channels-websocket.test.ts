import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches, setRunningRecorder } from "../src/context/channels.js";
import { createObservedCollector, type ObservedCollector } from "../src/context/observed.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { webSocketLineOf } from "../src/context/websocket-line.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the events of a global `WebSocket` in a step's record
// (src/context/channels.ts, src/context/observed.ts, and the line in
// src/context/websocket-line.ts): a frame sent counts for the step whose
// scope sent it, an open and a frame received count for the step running
// when they arrive, the connection is no longer an unmeasured socket, a
// secret in a text frame is redacted, and a binary frame keeps its size
// only. The server is a few lines of the protocol on node:http, since
// Node has no WebSocket server of its own.

const SECRET = "s3cret-value";

let server: http.Server;
let wsBase: string;
const accepted: net.Socket[] = [];

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
}

beforeAll(async () => {
  installChannelPatches();
  server = http.createServer((_req, res) => res.end());
  server.on("upgrade", (req, socket: net.Socket) => {
    accepted.push(socket);
    const accept = createHash("sha1")
      .update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // Each frame the client sends comes back to it with the same opcode,
    // prefixed with "echo:" when it is text.
    socket.on("data", (buf: Buffer) => {
      const opcode = buf[0]! & 15;
      if (opcode === 8) {
        socket.end(serverFrame(8, Buffer.alloc(0)));
        return;
      }
      let length = buf[1]! & 127;
      let offset = 2;
      if (length === 126) {
        length = buf.readUInt16BE(2);
        offset = 4;
      }
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]!));
      socket.write(serverFrame(opcode, opcode === 1 ? Buffer.concat([Buffer.from("echo:"), payload]) : payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  wsBase = `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of accepted) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

let dir: string;
let observed: ObservedCollector;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dir = await createEmptyTempDir();
  observed = createObservedCollector({
    outputDir: () => path.join(dir, "record"),
    secrets: [{ name: "TOKEN", value: SECRET }],
  });
  setRunningRecorder(observed);
});

afterEach(async () => {
  setRunningRecorder(undefined, observed);
  for (const socket of sockets.splice(0)) socket.close();
  await removeTempDir(dir);
});

function inStep<T>(fn: () => Promise<T>): Promise<T> {
  return withProcessRecording(observed.openRun([]), fn);
}

function lines(): Record<string, unknown>[] {
  try {
    return readFileSync(path.join(dir, "record", "websocket.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const { at: _at, ...rest } = JSON.parse(line) as Record<string, unknown>;
        return rest;
      });
  } catch {
    return [];
  }
}

/** The lines after the open events, for a socket opened before the step
 * under test: this collector writes every boundary into one directory. */
function framesOnly(): Record<string, unknown>[] {
  return lines().filter((line) => line.event !== "open");
}

/** A socket opened outside every step, as a fixture opens one. */
async function openedSocket(): Promise<WebSocket> {
  const socket = new WebSocket(wsBase);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => socket.addEventListener("message", (event) => resolve(event.data), { once: true }));
}

describe("a global WebSocket in a step", () => {
  it("writes the frame a step sends and the one it receives, and leaves the connection out of unmeasured", async () => {
    const socket = await openedSocket();
    observed.reset();
    await inStep(async () => {
      const reply = nextMessage(socket);
      socket.send(`hello ${SECRET}`);
      await reply;
    });
    const number = framesOnly()[0]?.socket;
    expect(typeof number).toBe("number");
    expect(framesOnly()).toEqual([
      { event: "sent", socket: number, url: `${wsBase}/`, data: "hello {{secret.TOKEN}}", bytes: 18 },
      { event: "received", socket: number, url: `${wsBase}/`, data: "echo:hello {{secret.TOKEN}}", bytes: 23 },
    ]);
    expect(observed.snapshot()).toMatchObject({ websocket: 2, unmeasured: [] });
  });

  it("writes the open of a socket a step makes, and its frames, into that step", async () => {
    await inStep(async () => {
      const socket = new WebSocket(wsBase);
      sockets.push(socket);
      await new Promise((resolve) => socket.addEventListener("open", resolve));
      const reply = nextMessage(socket);
      socket.send(new Uint8Array([1, 2, 3]));
      await reply;
    });
    expect(lines().map(({ socket: _socket, ...rest }) => rest)).toEqual([
      { event: "open", url: `${wsBase}/` },
      { event: "sent", url: `${wsBase}/`, binary: true, bytes: 3 },
      { event: "received", url: `${wsBase}/`, binary: true, bytes: 3 },
    ]);
    expect(observed.snapshot()).toMatchObject({ websocket: 3, unmeasured: [] });
  });

  it("numbers two sockets to one URL apart", async () => {
    const first = await openedSocket();
    const second = await openedSocket();
    observed.reset();
    await inStep(async () => {
      const replies = [nextMessage(first), nextMessage(second)];
      first.send("a");
      second.send("b");
      await Promise.all(replies);
    });
    const numbers = new Set(lines().map((line) => line.socket));
    expect(numbers.size).toBe(2);
  });

  it("writes a frame received between steps beside the step before, marked after_step_end, and does not count it", async () => {
    const socket = await openedSocket();
    observed.reset();
    await inStep(async () => undefined);
    observed.close();
    socket.send("late");
    await nextMessage(socket);
    expect(framesOnly()).toMatchObject([
      { event: "sent", data: "late", after_step_end: true },
      { event: "received", data: "echo:late", after_step_end: true },
    ]);
    expect(observed.snapshot().websocket).toBeUndefined();
  });

  it("records nothing when no step boundary runs in the process", async () => {
    setRunningRecorder(undefined, observed);
    const socket = await openedSocket();
    socket.send("nobody");
    await nextMessage(socket);
    expect(lines()).toEqual([]);
  });
});

describe("webSocketLineOf", () => {
  it("keeps a text frame's UTF-8 size, and never a secret, whatever surrounds it", () =>
    hegel.test((tc) => {
      const before = tc.draw(gs.text({ maxSize: 40 }));
      const after = tc.draw(gs.text({ maxSize: 40 }));
      const text = `${before}${SECRET}${after}`;
      const line = webSocketLineOf({ event: "received", socket: 1, url: "ws://x/", data: text }, new Date(0), [{ name: "TOKEN", value: SECRET }]);
      expect(line.bytes).toBe(Buffer.byteLength(text, "utf8"));
      expect(line.data ?? "").not.toContain(SECRET);
    }));
});
