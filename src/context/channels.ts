import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import workerThreads from "node:worker_threads";
import type { UnmeasuredEntry } from "../record/types.js";
import { childProcessDetail } from "./child-process-detail.js";
import { BODY_CAP, type RawBody, rawBodyOf, windowFor } from "./kept-text.js";
import type { Identity } from "./step-files.js";
import { writeMadeByPlaywrightServer } from "./write-origin.js";

// Responsibility: measure, inside a step's own `run`, the channels a step
// reaches without a nukadoko helper (docs/spec.md "Records"): requests
// through `globalThis.fetch`, `node:http`, and `node:https`; writes through
// `node:fs`; and, as unmeasured actions, a process started without
// `runCommand`, a `worker_threads.Worker`, and a connection that carries
// no recorded request. It records nothing itself: each patch hands what it
// saw to the recorder the step's scope holds, and the recorder
// (observed.ts) owns the step record's shape, redaction, and files.
//
// Boundary: every patch is installed once per process and records only
// while a step's scope (run-command.ts's AsyncLocalStorage, the one the
// executor opens around a step's `run`) is active. Outside a step it
// calls the original and nothing else, and every patched function keeps
// the original's name, length, and synchronous throws, so a fixture, a
// hook, and the executor itself see the builtins as Node ships them.
// Inside a step, recording never throws: a patch reads its arguments
// before the original validates them, so an argument the original rejects
// (a Symbol, a file URL with a host, a relative path after the working
// directory was removed) must reach the original and fail there, with the
// original's own error.
// Inside a step, nukadoko's own I/O must not record itself: runCommand's
// spawn, Playwright's request send and browser launch, and the recorder's
// own writes run under `withoutChannelRecording`, and the recorder drops
// writes under the state directory and Playwright's output directories.
// A write Playwright's server-side code makes is not the step's either,
// whichever code launched the browser: the `node:fs` patch asks
// write-origin.ts who made the call, and runs a server call with
// recording off.
//
// The suppression is an AsyncLocalStorage and not a flag, so it covers
// the asynchronous work a suppressed call starts (undici's connection for
// a `fetch`). It is not used where a call hands back an emitter whose
// listeners are the step's own code: a listener runs in the context the
// emitter was created in, so suppressing `http.request` would silence the
// step's own response handler too. Those calls use `insideSyncCall`
// instead, which covers only what runs before the call returns: the
// socket an `http.request` opens, the `spawn` an `exec` makes.
//
// Patching a builtin's export object is not enough for a module that
// imported a named binding (`import { request } from "node:http"`), so
// `syncBuiltinESMExports` runs after the patches. A module that copied a
// function before the patches were installed keeps the original, and its
// calls are not seen; the executor installs early (create-context.ts) to
// keep that set small.
//
// Measured on Node 22.22.0 with msw 2.15.0 and nock 14.0.17, both on
// @mswjs/interceptors 0.41.9, one mocked `node:http` GET and one mocked
// `fetch` inside a step: installed before these patches, both are recorded
// with the mocked response. Installed after them, the `node:http` request
// is still recorded and the `fetch` is not: the interceptor's `fetch`
// answers without calling the one it replaced. In all four cases the step
// got the mocked responses and `unmeasured` stayed empty.
//
// Sockets are judged at the step's end, not when they connect. A client
// socket is accounted for once it carries a recorded request (the
// `ClientRequest` `socket` event, whenever an agent hands it over) or when
// nukadoko's own I/O opened it. One the step connected, or one opened
// before the step that the step wrote to, that is still not accounted for
// is an unmeasured connection. Only sockets that connect are judged: a
// server's accepted connections, a child process's pipes (process.stdout,
// stderr, and the stdin `runCommand` writes), and the IPC channel never
// call `Socket#connect`, so they are never one. A connection opened before
// the step that the step only reads from is not seen: nothing marks a read
// as the step's.
//
// What no patch reaches: a Worker's own globals, a native addon, a child
// process's own traffic, a function copied before installation, a
// connection opened before installation, and work that runs outside the
// step's async context (a callback a server started by a fixture invokes,
// for example).

/** One request a patch saw, before redaction. */
export interface ChannelHttpLine {
  readonly method: string;
  readonly url: string;
  readonly declared_url?: string;
  readonly status: number;
  readonly duration_ms: number;
  readonly via: "fetch" | "node:http" | "node:https" | "request";
  /** `via: "request"` from a `pageAs(name)` context's `page.request`. */
  readonly as?: string;
  readonly error?: string;
  readonly request_body?: RawBody;
  readonly response_body?: RawBody;
}

/** Where nukadoko stopped waiting for a request: at its step boundary's
 * flush, or at the end of the run (or of the `nuka do` call). */
export type WaitEnd = "step" | "run";

/** A request whose line is not written yet. */
export interface PendingCapture {
  /** Settles once the line is written. */
  readonly done: Promise<void>;
  /** True when the line can be written now without waiting for anything:
   * a response whose body the step never started reading, which nothing
   * will ever read once the step's `run` has returned. */
  idle?(): boolean;
  /** Writes the line with what arrived so far: `status: 0` and the
   * no-response error when no response came, a body marked incomplete when
   * one was still arriving, a body marked unread when the step never
   * started reading it. Does nothing once the line is written. */
  finalize(end: WaitEnd): void;
}

/** A client socket the patches saw connect. */
export interface SocketUse {
  /** `host:port`, or the path of a local socket. */
  readonly address: string;
  /** True once nukadoko accounts for its traffic: nukadoko's own I/O
   * opened it, or it carried a recorded request. Read when the step's
   * record is built, since a socket can become a request's later than it
   * connected. */
  readonly owned: boolean;
}

/** What a step's scope holds for these patches. The scope is shared with
 * run-command.ts's ProcessRecorder, and a copy of an older nukadoko can
 * put a recorder there without these members, so each is checked. */
export interface ChannelRecorder {
  /** Counts one request and returns the function that writes its line
   * into the step that sent it, whenever the line is finished. */
  startHttp(): (line: ChannelHttpLine) => void;
  /** Keeps `capture` until its line is written, for the step boundary's
   * flush and the run's end. Returns the function that lets it go, which
   * the capture calls as it writes its line, so a finished request holds
   * none of its buffers; an older recorder returns nothing. */
  track(capture: PendingCapture): (() => void) | void;
  /** Notes a path a write call names, before the call runs. `before` is
   * given when the caller already knows the path did not exist.
   * `byPlaywrightServer` says whether Playwright's own server-side code
   * made the call; the recorder asks it only for a path it would list, so
   * the call stack is read once per new path, not once per write. */
  touchFile(absolutePath: string, before?: Identity, byPlaywrightServer?: () => boolean): void;
  /** Notes an action nukadoko cannot measure. */
  markUnmeasured(entry: UnmeasuredEntry): void;
  /** Notes a socket the step connected, or wrote to after another context
   * connected it. Whether it was measured is decided at the step's end. */
  noteSocket(use: SocketUse, how: "connect" | "write"): void;
}

const SCOPE_KEY = Symbol.for("nukadoko.runCommand.scope");
const SUPPRESS_KEY = Symbol.for("nukadoko.channels.suppress");
const INSTALLED_KEY = Symbol.for("nukadoko.channels.installed");

const BODY_WINDOW = windowFor(BODY_CAP);

function suppression(): AsyncLocalStorage<true> {
  const holder = globalThis as { [SUPPRESS_KEY]?: AsyncLocalStorage<true> };
  holder[SUPPRESS_KEY] ??= new AsyncLocalStorage<true>();
  return holder[SUPPRESS_KEY];
}

/** Runs `fn` so no patch records what it, or the asynchronous work it
 * starts, does: nukadoko's own I/O inside a step. */
export function withoutChannelRecording<T>(fn: () => T): T {
  return suppression().run(true, fn);
}

let syncDepth = 0;

function insideSyncCall<T>(fn: () => T): T {
  syncDepth += 1;
  try {
    return fn();
  } finally {
    syncDepth -= 1;
  }
}

function isNukadokoOwnIo(): boolean {
  return syncDepth > 0 || suppression().getStore() === true;
}

/** The recorder of the step whose scope is active, or `undefined` outside
 * a step, inside nukadoko's own I/O, or for an older recorder. */
export function channelRecorder(): ChannelRecorder | undefined {
  if (isNukadokoOwnIo()) return undefined;
  const holder = globalThis as { [SCOPE_KEY]?: AsyncLocalStorage<Partial<ChannelRecorder>> };
  const store = holder[SCOPE_KEY]?.getStore();
  return store !== undefined && typeof store.startHttp === "function" && typeof store.noteSocket === "function"
    ? (store as ChannelRecorder)
    : undefined;
}

/** `wrapper`, given the name and length of `original`, so code that reads
 * either sees the builtin it expects. */
function sameShape<T extends object>(wrapper: T, original: (...args: never[]) => unknown): T {
  Object.defineProperty(wrapper, "name", { value: original.name, configurable: true });
  Object.defineProperty(wrapper, "length", { value: original.length, configurable: true });
  return wrapper;
}

/** The first line of what was thrown, for a line's `error`. Anything can
 * be thrown, a Symbol or an object whose `toString` throws included. */
function firstLine(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    return "a thrown value that has no text";
  }
  return message.split("\n", 1)[0] ?? "";
}

/** The `error` of a request that had no response when nukadoko stopped
 * waiting: when, and how long the request had by then, since a request
 * the step's leftover code sent during the flush had less than the flush
 * waited. */
export function noResponse(end: WaitEnd, sentMs: number): string {
  return `no response before the ${end} ended, ${sentMs} ms after it was sent`;
}

/** Keeps the first BODY_WINDOW bytes of a body the step's own code reads,
 * and counts all of them. It never reads on its own, so it holds at most
 * the window however long the body is. */
class BodyBuffer {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  total = 0;

  add(chunk: Uint8Array): void {
    this.total += chunk.byteLength;
    if (this.kept >= BODY_WINDOW) return;
    const part = Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, BODY_WINDOW - this.kept));
    this.chunks.push(Buffer.from(part));
    this.kept += part.byteLength;
  }

  window(): Uint8Array {
    return Buffer.concat(this.chunks);
  }

  ended(): RawBody {
    return { window: this.window(), total: this.total };
  }

  /** nukadoko stopped waiting while the body was arriving. */
  stopped(): RawBody {
    return { window: this.window(), read: this.total, stopped: "wait" };
  }

  /** The body ended with an error, an abort, or a close before its end,
   * which nukadoko did not cause. */
  failed(error: string): RawBody {
    return { window: this.window(), read: this.total, error };
  }
}

/** Reads the start of `stream`, a branch nukadoko owns, to keep a body's
 * first BODY_WINDOW bytes. It stops one chunk past the window and cancels
 * the branch, so the branch the step reads keeps its own pace and a body of
 * any length costs at most the window and a chunk. `finalize` stops at the
 * step's end with what arrived: an event stream never ends. A read that
 * fails (the server aborted, the step aborted the request) is the body's
 * error, not an incomplete body. */
export function captureStream(stream: ReadableStream<Uint8Array>): { done: Promise<RawBody>; finalize(): RawBody } {
  const buffer = new BodyBuffer();
  const reader = stream.getReader();
  let result: RawBody | undefined;
  const stop = (body: RawBody): RawBody => {
    if (result === undefined) {
      result = body;
      reader.cancel().catch(() => undefined);
    }
    return result;
  };
  const done = (async (): Promise<RawBody> => {
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (result !== undefined) return result;
        if (ended) return (result = buffer.ended());
        buffer.add(value);
        if (buffer.total > BODY_WINDOW) return stop({ window: buffer.window(), read: buffer.total, stopped: "cap" });
      }
    } catch (error) {
      return result ?? (result = buffer.failed(firstLine(error)));
    }
  })();
  return { done, finalize: () => stop(buffer.stopped()) };
}

/** The body a `fetch` sends, as the record keeps it. The caller's
 * arguments go to the original exactly as given, never spread or rebuilt:
 * an `init` can be a Request or a class instance whose fields are
 * getters on its prototype, which a copy would drop. So a body is read
 * only from something nukadoko can take without changing what the caller
 * passed: a value in hand, a Blob slice, a Request clone. A stream or
 * FormData body in a plain `init` cannot be read that way (a stream read
 * by nukadoko is a stream `fetch` no longer has, and FormData is encoded,
 * with its boundary, only inside `fetch`), so it is named unread. Throws
 * where reading throws, and then the line has no request body. */
interface FetchBody {
  readonly body: Promise<RawBody | undefined> | RawBody | undefined;
  readonly pending?: { finalize(): RawBody };
}

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function capturedBody(stream: ReadableStream<Uint8Array>): FetchBody {
  const capture = captureStream(stream);
  return { body: capture.done, pending: capture };
}

function requestBodyOf(args: FetchArgs): FetchBody {
  const [input, init] = args;
  // A Request given as `init` (a forwarding proxy passes the incoming one)
  // is what `fetch` reads its body from.
  if (init instanceof Request) return init.body === null ? { body: undefined } : capturedBody(init.clone().body!);
  const body = init?.body;
  if (body === undefined || body === null) {
    if (input instanceof Request && input.body !== null) return capturedBody(input.clone().body!);
    return { body: undefined };
  }
  if (typeof body === "string") return { body: rawBodyOf(Buffer.from(body, "utf8")) };
  if (body instanceof URLSearchParams) return { body: rawBodyOf(Buffer.from(body.toString(), "utf8")) };
  if (body instanceof ArrayBuffer) return { body: rawBodyOf(new Uint8Array(body)) };
  if (ArrayBuffer.isView(body)) return { body: rawBodyOf(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
  if (body instanceof Blob) {
    // A Blob knows its size, so only the window is read, from a slice.
    const size = body.size;
    return {
      body: body
        .slice(0, BODY_WINDOW)
        .arrayBuffer()
        .then(
          (bytes): RawBody => ({ window: new Uint8Array(bytes), total: size }),
          (): RawBody => ({ unread: "a Blob body that could not be read" }),
        ),
    };
  }
  if (body instanceof FormData) return { body: { unread: "a FormData body, which fetch encodes itself" } };
  if (body instanceof ReadableStream) return { body: { unread: "a stream body, which nukadoko cannot read without taking it from fetch" } };
  return { body: { unread: "a body that could not be read without consuming it" } };
}

/**
 * Counts one request, tracks it until its line is written, and returns the
 * function that writes its line, once. The line is appended as soon as the
 * request completes, and the recorder lets the request go then, so what
 * stays in memory for a finished request is its count. `atEnd` builds the
 * line from what the request has when nukadoko stops waiting, at the step
 * boundary's flush or at the run's end. One rule for every client: a
 * request with no response by then is written with `status: 0` and the
 * no-response error, and nothing arriving later changes it.
 */
export function recordRequest(
  rec: ChannelRecorder,
  atEnd: (end: WaitEnd) => ChannelHttpLine,
  idle?: () => boolean,
): (line: ChannelHttpLine) => void {
  const write = rec.startHttp();
  let written = false;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let release: (() => void) | void = undefined;
  const once = (line: ChannelHttpLine): void => {
    if (written) return;
    written = true;
    if (typeof release === "function") release();
    write(line);
    settle();
  };
  release = rec.track({ done, ...(idle !== undefined ? { idle } : {}), finalize: (end) => once(atEnd(end)) });
  return once;
}

function fetchTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

function fetchMethod(args: FetchArgs): string {
  const [input, init] = args;
  return String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

async function recordedFetch(rec: ChannelRecorder, original: typeof fetch, args: FetchArgs): Promise<Response> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  let method = "GET";
  let declared = "";
  let request: FetchBody;
  try {
    method = fetchMethod(args);
    declared = fetchTarget(args[0]);
    request = requestBodyOf(args);
  } catch {
    // The caller's own arguments still go to the original, so the caller
    // gets exactly the error `fetch` throws for them, and the line
    // records it.
    request = { body: undefined };
  }
  let requestBody: RawBody | undefined = request.body instanceof Promise ? undefined : request.body;
  const requestBodyRead = Promise.resolve(request.body).then(
    (body) => (requestBody = body),
    () => (requestBody = { unread: "the request body could not be read" }),
  );
  const requestBodyNow = (): RawBody | undefined => requestBody ?? request.pending?.finalize();
  let responded: { readonly line: ChannelHttpLine; readonly capture?: { done: Promise<RawBody>; finalize(): RawBody } } | undefined;
  // Set when the original threw, so a flush that comes before the request
  // body was read still writes the real error.
  let thrown: { readonly error: string; readonly durationMs: number } | undefined;
  const failed = (error: string, durationMs: number): ChannelHttpLine => {
    const body = requestBodyNow();
    return { method, url: declared, status: 0, duration_ms: durationMs, via: "fetch", error, ...(body !== undefined ? { request_body: body } : {}) };
  };
  const withBodies = (line: ChannelHttpLine, requestRaw: RawBody | undefined, responseRaw: RawBody | undefined): ChannelHttpLine => ({
    ...line,
    ...(requestRaw !== undefined ? { request_body: requestRaw } : {}),
    ...(responseRaw !== undefined ? { response_body: responseRaw } : {}),
  });
  const write = recordRequest(rec, (end) =>
    responded === undefined
      ? thrown === undefined
        ? failed(noResponse(end, elapsed()), elapsed())
        : failed(thrown.error, thrown.durationMs)
      : withBodies(responded.line, requestBodyNow(), responded.capture?.finalize()),
  );

  let response: Response;
  try {
    response = await withoutChannelRecording(() => original(...args));
  } catch (error) {
    const failure = { error: firstLine(error), durationMs: elapsed() };
    thrown = failure;
    void requestBodyRead.then(() => write(failed(failure.error, failure.durationMs)));
    throw error;
  }
  const url = response.url !== "" ? response.url : declared;
  const line: ChannelHttpLine = {
    method,
    url,
    ...(url !== declared ? { declared_url: declared } : {}),
    status: response.status,
    duration_ms: elapsed(),
    via: "fetch",
  };
  let capture: { done: Promise<RawBody>; finalize(): RawBody } | undefined;
  if (response.body !== null) {
    try {
      capture = captureStream(response.clone().body!);
    } catch {
      capture = undefined;
    }
  }
  responded = { line, ...(capture !== undefined ? { capture } : {}) };
  void Promise.all([requestBodyRead, capture?.done]).then(([, responseRaw]) => write(withBodies(line, requestBody, responseRaw)));
  return response;
}

function installFetch(): void {
  const original = globalThis.fetch;
  if (typeof original !== "function") return;
  const patched = sameShape(async function fetch(...args: FetchArgs): Promise<Response> {
    const rec = channelRecorder();
    if (rec === undefined) return original(...args);
    return recordedFetch(rec, original, args);
  }, original);
  globalThis.fetch = patched as typeof fetch;
}

/** The bytes of one chunk a stream emitted or a write was given. A string
 * is turned back into bytes with the encoding it was decoded with (a
 * response after `setEncoding`) or given in, so redaction reads the same
 * text whether or not the step asked for strings. */
export function chunkBytes(chunk: unknown, encoding: unknown): Uint8Array | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === "function") return undefined;
  if (typeof chunk === "string") return Buffer.from(chunk, typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8");
  if (chunk instanceof Uint8Array) return chunk;
  return undefined;
}

/** Whether a response has no body by protocol: the answer to a HEAD, a
 * 204, a 304, or one that says `content-length: 0`. Its line is complete
 * at the status, and nothing would ever end a body nobody reads. */
function noBodyByProtocol(method: string, res: http.IncomingMessage): boolean {
  const status = res.statusCode ?? 0;
  return method === "HEAD" || status === 204 || status === 304 || res.headers["content-length"] === "0";
}

/** Records one `ClientRequest` passively: it listens to what the request
 * and its response already emit and never changes their flow, so a
 * response the step leaves unread stays unread, and an `upgrade` or
 * `connect` with no listener of the step's own still destroys the socket
 * as Node does. A response the step never started reading (no `data` or
 * `readable` listener, never resumed or piped) is idle: the flush writes
 * its line at once, saying the step did not read the body, instead of
 * waiting for a body nothing will read. */
function tapClientRequest(req: http.ClientRequest, via: "node:http" | "node:https", rec: ChannelRecorder): void {
  const startedAt = performance.now();
  const requestBody = new BodyBuffer();
  const responseBody = new BodyBuffer();
  let status = 0;
  let durationMs: number | undefined;

  const originalWrite = req.write;
  req.write = function (this: http.ClientRequest, chunk: unknown, ...rest: unknown[]): boolean {
    const bytes = chunkBytes(chunk, rest[0]);
    if (bytes !== undefined) requestBody.add(bytes);
    return (originalWrite as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof req.write;
  const originalEnd = req.end;
  req.end = function (this: http.ClientRequest, chunk?: unknown, ...rest: unknown[]): http.ClientRequest {
    const bytes = chunkBytes(chunk, rest[0]);
    if (bytes !== undefined) requestBody.add(bytes);
    return (originalEnd as (...a: unknown[]) => http.ClientRequest).call(this, chunk, ...rest);
  } as typeof req.end;

  // A CONNECT request names a host and port, not a path.
  const url = (): string =>
    req.method === "CONNECT" ? req.path : `${req.protocol}//${String(req.getHeader("host") ?? req.host)}${req.path}`;
  const line = (fields: { readonly error?: string; readonly response?: RawBody }): ChannelHttpLine => ({
    method: req.method,
    url: url(),
    status,
    duration_ms: durationMs ?? Math.round(performance.now() - startedAt),
    via,
    ...(fields.error !== undefined ? { error: fields.error } : {}),
    ...(requestBody.total > 0 ? { request_body: requestBody.ended() } : {}),
    ...(fields.response !== undefined ? { response_body: fields.response } : {}),
  });
  let response: http.IncomingMessage | undefined;
  const idle = (): boolean =>
    response !== undefined && responseBody.total === 0 && response.readableFlowing === null && response.listenerCount("readable") === 0;
  const write = recordRequest(
    rec,
    (end) =>
      status === 0
        ? line({ error: noResponse(end, Math.round(performance.now() - startedAt)) })
        : line({ response: idle() ? { unread: "the step did not read the body" } : responseBody.stopped() }),
    idle,
  );
  const responded = (res: http.IncomingMessage): void => {
    status = res.statusCode ?? 0;
    durationMs = Math.round(performance.now() - startedAt);
  };

  const originalEmit = req.emit;
  req.emit = function (this: http.ClientRequest, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "socket") {
      ownSocket(args[0]);
    } else if (event === "response") {
      const res = args[0] as http.IncomingMessage;
      responded(res);
      if (noBodyByProtocol(req.method, res)) {
        write(line({}));
      } else {
        response = res;
        const resEmit = res.emit;
        res.emit = function (this: http.IncomingMessage, resEvent: string | symbol, ...resArgs: unknown[]): boolean {
          if (resEvent === "data") {
            const bytes = chunkBytes(resArgs[0], res.readableEncoding);
            if (bytes !== undefined) responseBody.add(bytes);
          } else if (resEvent === "end") {
            write(line({ response: responseBody.ended() }));
          } else if (resEvent === "error") {
            write(line({ response: responseBody.failed(firstLine(resArgs[0])) }));
          } else if (resEvent === "aborted" || resEvent === "close") {
            // A close before `end`: the server aborted, or the step
            // destroyed the response. Either way nukadoko did not stop it.
            write(line({ response: responseBody.failed("the response closed before its end") }));
          }
          return (resEmit as (...a: unknown[]) => boolean).call(this, resEvent, ...resArgs);
        } as typeof res.emit;
      }
    } else if (event === "upgrade" || event === "connect") {
      // The handshake is this request's line, with its real status. What
      // the connection carries afterwards is no HTTP request: it is marked,
      // and the flush does not wait for it.
      responded(args[0] as http.IncomingMessage);
      write(line({}));
      rec.markUnmeasured({
        kind: "socket",
        detail: event === "upgrade" ? `traffic after the upgrade of ${url()}` : `traffic through the CONNECT tunnel to ${url()}`,
      });
    } else if (event === "error" && status === 0) {
      write(line({ error: firstLine(args[0]) }));
    } else if (event === "close" && status === 0) {
      // `abort()` and a destroy without an error close with neither a
      // response nor an error event.
      write(line({ error: "the request was closed before a response arrived" }));
    }
    return (originalEmit as (...a: unknown[]) => boolean).call(this, event, ...args);
  } as typeof req.emit;
}

function installNodeHttp(): void {
  for (const [mod, via] of [
    [http, "node:http"],
    [https, "node:https"],
  ] as const) {
    const original = mod.request;
    const request = sameShape(function request(this: unknown, ...args: unknown[]): http.ClientRequest {
      const rec = channelRecorder();
      // Inside the call, so the socket it opens is nukadoko's to judge
      // through the request, never an unmeasured one.
      const req = insideSyncCall(() => (original as (...a: unknown[]) => http.ClientRequest).apply(this, args));
      if (rec !== undefined) {
        try {
          tapClientRequest(req, via, rec);
        } catch {
          // A tap that fails leaves the request as it was.
        }
      }
      return req;
    }, original) as typeof mod.request;
    // `get` calls the module's own `request`, not the export, so it is
    // patched too.
    const get = sameShape(function get(this: unknown, ...args: unknown[]): http.ClientRequest {
      const req = (request as (...a: unknown[]) => http.ClientRequest).apply(this, args);
      req.end();
      return req;
    }, mod.get) as typeof mod.get;
    (mod as { request: typeof mod.request }).request = request;
    (mod as { get: typeof mod.get }).get = get;
  }
}

const CHILD_PROCESS_CALLS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

function installChildProcess(): void {
  const target = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of CHILD_PROCESS_CALLS) {
    const original = target[name];
    if (typeof original !== "function") continue;
    const marked = sameShape(function (this: unknown, ...args: unknown[]): unknown {
      const rec = channelRecorder();
      // `exec` calls `spawn`: one process, recorded once.
      let result: unknown;
      try {
        result = insideSyncCall(() => original.apply(this, args));
      } catch (error) {
        // `execSync` and `execFileSync` throw for a process that ran and
        // failed, so the mark comes first, and the caller gets the very
        // error the call threw.
        if (rec !== undefined && startedProcess(name, error, true)) markProcess(rec, name, args);
        throw error;
      }
      if (rec !== undefined && startedProcess(name, result, false)) markProcess(rec, name, args);
      return result;
    }, original);
    // `promisify(exec)` and `promisify(execFile)` resolve to
    // `{ stdout, stderr }` only through the custom form Node puts on the
    // originals. That form calls the original directly, so copying it would
    // skip the mark; the wrapper gets the same form over itself instead.
    const custom = (original as { [promisify.custom]?: (...args: never[]) => unknown })[promisify.custom];
    if (typeof custom === "function") {
      Object.defineProperty(marked, promisify.custom, { value: sameShape(promisedExec(marked), custom), configurable: true });
    }
    target[name] = marked;
  }
}

/** Whether a `node:child_process` call started a process, from what it
 * returned or threw, so a call that started none marks nothing. The
 * measure is the child's pid: a ChildProcess has one once its spawn
 * succeeded, and none when the program was not found (the error comes
 * later, as an event); `spawnSync`'s result, and the error `execSync`
 * and `execFileSync` throw for a process that exited non-zero, timed
 * out, or overflowed its buffer, carry it, 0 when the spawn failed. An
 * error thrown on the arguments carries none. `execSync` and
 * `execFileSync` return only the output, which they have only from a
 * process that ran. */
function startedProcess(call: string, outcome: unknown, threw: boolean): boolean {
  if (!threw && (call === "execSync" || call === "execFileSync")) return true;
  try {
    const pid = typeof outcome === "object" && outcome !== null ? (outcome as { pid?: unknown }).pid : undefined;
    return typeof pid === "number" && pid > 0;
  } catch {
    // A getter that throws on a value the call gave back is no pid.
    return false;
  }
}

function markProcess(rec: ChannelRecorder, call: string, args: readonly unknown[]): void {
  let detail: string;
  try {
    detail = childProcessDetail(call, args);
  } catch {
    // The call accepted these arguments, so reading them again throws only
    // for a value whose getter changed its mind; the process is still
    // marked, without its name.
    detail = `${call} (a program nukadoko could not name)`;
  }
  rec.markUnmeasured({ kind: "child_process", detail });
}

type ExecOutput = { stdout: unknown; stderr: unknown };

/** Node's own promise form of `exec` and `execFile`, over `call`: the
 * child on `promise.child`, `{ stdout, stderr }` on success, and the
 * error with both outputs attached on failure. `call` runs outside the
 * promise, as in Node, so an argument it rejects throws synchronously. */
function promisedExec(call: (...args: unknown[]) => unknown): (...args: unknown[]) => Promise<ExecOutput> {
  return (...args) => {
    let resolve: (value: ExecOutput) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<ExecOutput>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const child = call(...args, (error: unknown, stdout: unknown, stderr: unknown) => {
      if (error !== null && error !== undefined) {
        Object.assign(error as object, { stdout, stderr });
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    return Object.assign(promise, { child });
  };
}

/** The host and port, or the path, a `Socket#connect` call names. Node
 * passes its own normalized `[options, callback]` array from
 * `net.connect`, and the public forms otherwise. */
function socketAddress(args: unknown[]): string {
  try {
    return readSocketAddress(args);
  } catch {
    return "an address nukadoko could not read";
  }
}

function readSocketAddress(args: unknown[]): string {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: unknown; host?: unknown; port?: unknown };
    if (options.path !== undefined && options.path !== null) return String(options.path);
    return `${String(options.host ?? "localhost")}:${String(options.port)}`;
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return first;
  return `${typeof args[1] === "string" ? args[1] : "localhost"}:${String(first)}`;
}

const sockets = new WeakMap<object, { readonly address: string; owned: boolean }>();

/** Accounts for `socket` and what it runs over: a TLS socket a proxy agent
 * opened over a tunnel carries the request through that tunnel's socket. */
function ownSocket(socket: unknown): void {
  let current = socket;
  for (let depth = 0; depth < 4 && current instanceof net.Socket; depth += 1) {
    const use = sockets.get(current);
    if (use === undefined) sockets.set(current, { address: "", owned: true });
    else use.owned = true;
    current = (current as { _parent?: unknown })._parent;
  }
}

function noteWrite(socket: object): void {
  const use = sockets.get(socket);
  if (use !== undefined && !use.owned) channelRecorder()?.noteSocket(use, "write");
}

function installNet(): void {
  const proto = net.Socket.prototype as unknown as Record<"connect" | "write" | "end", (...args: unknown[]) => unknown>;
  const connect = proto.connect;
  proto.connect = sameShape(function (this: net.Socket, ...args: unknown[]): unknown {
    if (sockets.has(this)) return connect.apply(this, args);
    // Known before the call, so a request that takes the socket while it
    // connects finds it; noted after it, so arguments `connect` rejects
    // connect nothing and name nothing.
    const use = { address: socketAddress(args), owned: isNukadokoOwnIo() };
    const rec = use.owned ? undefined : channelRecorder();
    sockets.set(this, use);
    let result: unknown;
    try {
      result = connect.apply(this, args);
    } catch (error) {
      sockets.delete(this);
      throw error;
    }
    rec?.noteSocket(use, "connect");
    return result;
  }, connect);
  // `write` is Writable's, and `end` with data does not call it, so both
  // are wrapped. The lookup is a WeakMap read for any socket nobody tracks.
  const write = proto.write;
  proto.write = sameShape(function (this: net.Socket, ...args: unknown[]): unknown {
    noteWrite(this);
    return write.apply(this, args);
  }, write);
  const end = proto.end;
  proto.end = sameShape(function (this: net.Socket, ...args: unknown[]): unknown {
    if (args[0] !== undefined && args[0] !== null && typeof args[0] !== "function") noteWrite(this);
    return end.apply(this, args);
  }, end);
}

/** The absolute path a write call names, or `undefined` when it names
 * none nukadoko can place. A file URL with a host, or a relative path
 * after the working directory was removed, throws here; the original then
 * fails on the same argument, so no write happened to record. */
function pathOf(value: unknown): string | undefined {
  try {
    if (typeof value === "string") return path.resolve(value);
    if (value instanceof URL) return value.protocol === "file:" ? path.resolve(fileURLToPath(value)) : undefined;
    if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  } catch {
    return undefined;
  }
  return undefined;
}

const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC;

function writesWith(flags: unknown): boolean {
  if (typeof flags === "string") return /[wa+]/.test(flags);
  if (typeof flags === "number") return (flags & WRITE_FLAGS) !== 0;
  return false;
}

type Holder = Record<string, (...args: unknown[]) => unknown>;

/** Who made one write call, read at most once, and only when the
 * recorder asks. */
function callOrigin(): { readonly ask: () => boolean; readonly answered: () => boolean | undefined } {
  let byServer: boolean | undefined;
  return {
    ask: () => (byServer ??= writeMadeByPlaywrightServer()),
    answered: () => byServer,
  };
}

// A call Playwright's server made runs with recording off, the way
// nukadoko's own I/O does: a recursive `rm`, `cp`, or a write stream
// carries on through Node's own code, which calls these same patched
// functions again on a stack that no longer holds Playwright's frames.
function runAs(origin: ReturnType<typeof callOrigin>, call: () => unknown): unknown {
  return origin.answered() === true ? withoutChannelRecording(call) : call();
}

function wrapWrite(holder: Holder, name: string, pathIndexes: readonly number[]): void {
  const original = holder[name];
  if (typeof original !== "function") return;
  holder[name] = sameShape(function (this: unknown, ...args: unknown[]): unknown {
    const rec = channelRecorder();
    if (rec === undefined) return original.apply(this, args);
    const origin = callOrigin();
    for (const index of pathIndexes) {
      const target = pathOf(args[index]);
      if (target !== undefined) rec.touchFile(target, undefined, origin.ask);
    }
    return runAs(origin, () => original.apply(this, args));
  }, original);
}

function wrapOpen(holder: Holder, name: string): void {
  const original = holder[name];
  if (typeof original !== "function") return;
  holder[name] = sameShape(function (this: unknown, ...args: unknown[]): unknown {
    const rec = channelRecorder();
    if (rec === undefined || !writesWith(args[1])) return original.apply(this, args);
    const origin = callOrigin();
    const target = pathOf(args[0]);
    if (target !== undefined) rec.touchFile(target, undefined, origin.ask);
    return runAs(origin, () => original.apply(this, args));
  }, original);
}

// A directory mkdtemp creates did not exist before the call, and its name
// is known only after it, so it is noted from the result. Who made the
// call is read at the call, since the result arrives on another stack.
function wrapMkdtemp(holder: Holder, name: string, form: "sync" | "callback" | "promise"): void {
  const original = holder[name];
  if (typeof original !== "function") return;
  holder[name] = sameShape(function (this: unknown, ...args: unknown[]): unknown {
    const rec = channelRecorder();
    if (rec === undefined) return original.apply(this, args);
    if (writeMadeByPlaywrightServer()) return withoutChannelRecording(() => original.apply(this, args));
    const note = (created: unknown): void => {
      const target = pathOf(created);
      if (target !== undefined) rec.touchFile(target, null);
    };
    if (form === "sync") {
      const created = original.apply(this, args);
      note(created);
      return created;
    }
    if (form === "promise") {
      return (original.apply(this, args) as Promise<unknown>).then((created) => {
        note(created);
        return created;
      });
    }
    const callback = args[args.length - 1];
    if (typeof callback !== "function") return original.apply(this, args);
    return original.apply(this, [
      ...args.slice(0, -1),
      (error: unknown, created: unknown) => {
        if (error === null || error === undefined) note(created);
        (callback as (...a: unknown[]) => void)(error, created);
      },
    ]);
  }, original);
}

const AT_FIRST = ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "truncate"] as const;
const AT_SECOND = ["copyFile", "cp", "symlink", "link"] as const;

function installFs(): void {
  const callbacks = fs as unknown as Holder;
  const promises = fs.promises as unknown as Holder;
  for (const name of AT_FIRST) {
    wrapWrite(callbacks, name, [0]);
    wrapWrite(callbacks, `${name}Sync`, [0]);
    wrapWrite(promises, name, [0]);
  }
  for (const name of AT_SECOND) {
    wrapWrite(callbacks, name, [1]);
    wrapWrite(callbacks, `${name}Sync`, [1]);
    wrapWrite(promises, name, [1]);
  }
  for (const holder of [callbacks, promises]) wrapWrite(holder, "rename", [0, 1]);
  wrapWrite(callbacks, "renameSync", [0, 1]);
  wrapWrite(callbacks, "createWriteStream", [0]);
  for (const [holder, name] of [
    [callbacks, "open"],
    [callbacks, "openSync"],
    [promises, "open"],
  ] as const) {
    wrapOpen(holder, name);
  }
  wrapMkdtemp(callbacks, "mkdtempSync", "sync");
  wrapMkdtemp(callbacks, "mkdtemp", "callback");
  wrapMkdtemp(promises, "mkdtemp", "promise");
}

/** What a Worker runs. */
function workerScript([filename, options]: ConstructorParameters<typeof workerThreads.Worker>): string {
  try {
    return options?.eval === true ? "inline code" : filename instanceof URL ? filename.href : String(filename);
  } catch {
    return "a script nukadoko could not read";
  }
}

// A Worker has its own globals, so none of the patches above reach what
// it does. It can only be marked.
function installWorker(): void {
  const Original = workerThreads.Worker;
  const Marked = class Worker extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      // Marked once the Worker exists: arguments the constructor rejects
      // start nothing.
      super(...args);
      channelRecorder()?.markUnmeasured({ kind: "worker_thread", detail: `new Worker ${workerScript(args)}` });
    }
  };
  (workerThreads as { Worker: typeof Original }).Worker = sameShape(Marked, Original as unknown as (...args: never[]) => unknown);
}

/** Installs every patch, once per process. Later calls, from this copy of
 * nukadoko or another, do nothing. */
export function installChannelPatches(): void {
  const holder = globalThis as { [INSTALLED_KEY]?: true };
  if (holder[INSTALLED_KEY] === true) return;
  holder[INSTALLED_KEY] = true;
  installFetch();
  installNodeHttp();
  installChildProcess();
  installNet();
  installFs();
  installWorker();
  syncBuiltinESMExports();
}
