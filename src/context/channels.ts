import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import diagnosticsChannel from "node:diagnostics_channel";
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
import { originOf, TRACEPARENT } from "./trace-context.js";
import type { WebSocketSeen } from "./websocket-line.js";
import { writeMadeByPlaywrightServer } from "./write-origin.js";

// Responsibility: measure, inside a step's own `run`, the channels a step
// reaches without a nukadoko helper (docs/spec.md "Records"): requests
// through `globalThis.fetch`, `node:http`, and `node:https`; the events of
// a global `WebSocket`; writes through `node:fs`; and, as unmeasured
// actions, a process started without
// `runCommand`, a `worker_threads.Worker`, a connection that carries
// no recorded request, and a UDP datagram sent through `node:dgram`. It
// records nothing itself: each patch hands what it
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
// A request to the world's origin also gets a `traceparent` header here,
// the recorder's (observed.ts, trace-context.ts), so the program's log can
// say which step sent it, and only where adding it changes nothing else
// the caller passed. A caller's own `traceparent` is kept. A request's
// line names the value it went out with, read from what was sent, whoever
// set it, and the origins that received it (`traceparent_sent_to`), so a
// redirected request's final URL is never taken for where the id went.
// The recorder counts a request as stamped only when nukadoko's value
// went out.
//
// `fetch` follows a redirect itself, and a header put in the caller's
// `init` would follow the redirect to whatever origin it names, a third
// party's included. So the caller's arguments go to the original
// untouched, and the header is added to each hop on its own: undici
// publishes every request it creates, the first and each redirect, on the
// `undici:request:create` diagnostics channel, and the subscriber adds
// the header to a hop whose origin is the world's, through the request's
// own `addHeader`. A hop's headers are made again from the caller's
// arguments, so a header added to one hop never reaches the next. One
// `fetch` call has one value, asked of the recorder at its first stamped
// hop and reused on the others, since it is one line of http.jsonl and
// one request the step counts. Measured on Node 22.22.0, 22.23.4,
// 24.22.1, and 26.12.1: the channel fires once per hop, before the hop is
// sent, in the `fetch` call's async context, and `addHeader` exists.
//
// `node:http` and `node:https` do not follow a redirect, so a
// `ClientRequest` is one hop. It gets the header at the moment its
// headers are sent (its first `write`, its `end`, or `flushHeaders`),
// not when it is created: a caller can still set its own `traceparent`
// between the two, and that is the one that goes out.
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
  /** The `traceparent` the request went out with, nukadoko's or the
   * caller's own; absent when it went out with none. */
  readonly traceparent?: string;
  /** The origins that received `traceparent`, present exactly when it
   * is (this file's header). */
  readonly traceparent_sent_to?: readonly string[];
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
  /** The `traceparent` for a request to `url` (resolved against `base`
   * when relative), counted as sent, or `undefined` when the URL is not
   * the world's or the run has no world. Called only once the caller knows
   * it will add the header. */
  traceparentFor?(url: string, base?: string): string | undefined;
  /** The `traceparent` for a request to `url`, counted only once
   * `sent` is called: for a client that learns whether the value went out
   * only after handing it over. `undefined` as for `traceparentFor`. */
  draftTraceparent?(url: string, base?: string): { readonly value: string; sent(): void } | undefined;
  /** Whether a request to `url` goes to the world, counting nothing. */
  isWorldUrl?(url: string, base?: string): boolean;
  /** Writes one event of a global `WebSocket` into the step. */
  webSocketEvent?(seen: WebSocketSeen): void;
}

const SCOPE_KEY = Symbol.for("nukadoko.runCommand.scope");
const RUNNING_KEY = Symbol.for("nukadoko.channels.running");
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

/** Executor-only: names the recorder of the step boundary that runs now in
 * this process, for an event that arrives in no step's scope (a WebSocket
 * frame received), or clears it when `recorder` is `undefined`. Clearing
 * with `owner` clears only while that recorder is still the one named. */
export function setRunningRecorder(recorder: Partial<ChannelRecorder> | undefined, owner?: Partial<ChannelRecorder>): void {
  const holder = globalThis as { [RUNNING_KEY]?: Partial<ChannelRecorder> };
  if (recorder === undefined && owner !== undefined && holder[RUNNING_KEY] !== owner) return;
  holder[RUNNING_KEY] = recorder;
}

function runningRecorder(): Partial<ChannelRecorder> | undefined {
  return (globalThis as { [RUNNING_KEY]?: Partial<ChannelRecorder> })[RUNNING_KEY];
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
export function firstLine(error: unknown): string {
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

/** One `fetch` call's stamp: the recorder that hands out the value, the
 * value once a hop to the world was given it, and what went out on the
 * hops, whoever set it (this file's header). */
interface FetchStamp {
  readonly rec: ChannelRecorder;
  ours: string | undefined;
  sent: string | undefined;
  readonly sentTo: Set<string>;
}

const fetchStamps = new AsyncLocalStorage<FetchStamp>();

/** The members of undici's request the hop stamp reads. */
interface UndiciRequest {
  readonly origin?: unknown;
  readonly path?: unknown;
  readonly headers?: unknown;
  addHeader?(name: string, value: string): unknown;
}

/** The first `traceparent` in a list of headers: undici's flat
 * `[name, value, ...]` array, or `name: value\r\n` text, which an older
 * undici keeps and a sent `ClientRequest`'s header block is. */
export function traceparentIn(headers: unknown): string | undefined {
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      if (String(headers[index]).toLowerCase() === TRACEPARENT) return String(headers[index + 1]);
    }
    return undefined;
  }
  if (typeof headers !== "string") return undefined;
  return /(?:^|\n)traceparent[ \t]*:[ \t]*([^\r\n]*)/i.exec(headers)?.[1]?.trimEnd();
}

/** Adds the `fetch` call's `traceparent` to one hop that goes to the
 * world and carries none of its own (this file's header). */
function stampFetchHop(message: unknown): void {
  const stamp = fetchStamps.getStore();
  if (stamp === undefined) return;
  try {
    const request = (message as { readonly request?: UndiciRequest } | null)?.request;
    if (request === undefined) return;
    const url = new URL(String(request.path), String(request.origin)).href;
    const went = (value: string): void => {
      stamp.sent ??= value;
      const origin = originOf(url);
      if (origin !== undefined) stamp.sentTo.add(origin);
    };
    const own = traceparentIn(request.headers);
    if (own !== undefined) {
      went(own);
      return;
    }
    if (typeof request.addHeader !== "function") return;
    if (stamp.ours === undefined) {
      stamp.ours = stamp.rec.traceparentFor?.(url);
      if (stamp.ours === undefined) return;
    } else if (stamp.rec.isWorldUrl?.(url) !== true) {
      return;
    }
    request.addHeader(TRACEPARENT, stamp.ours);
    went(stamp.ours);
  } catch {
    // A hop nukadoko cannot read goes as undici made it.
  }
}

async function recordedFetch(rec: ChannelRecorder, original: typeof fetch, args: FetchArgs): Promise<Response> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  let method = "GET";
  let declared = "";
  let request: FetchBody;
  const stamp: FetchStamp = { rec, ours: undefined, sent: undefined, sentTo: new Set() };
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
  // Read when the line is made: the value is known once a hop was sent.
  const stampField = (): { traceparent?: string; traceparent_sent_to?: readonly string[] } =>
    stamp.sent === undefined ? {} : { traceparent: stamp.sent, traceparent_sent_to: [...stamp.sentTo] };
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
    return {
      method,
      url: declared,
      status: 0,
      duration_ms: durationMs,
      via: "fetch",
      error,
      ...stampField(),
      ...(body !== undefined ? { request_body: body } : {}),
    };
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
    response = await withoutChannelRecording(() => fetchStamps.run(stamp, () => original(...args)));
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
    ...stampField(),
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
  diagnosticsChannel.subscribe("undici:request:create", stampFetchHop);
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

/** The URL a `ClientRequest` goes to. A CONNECT request names a host and
 * port, not a path. */
function clientRequestUrl(req: http.ClientRequest): string {
  return req.method === "CONNECT" ? req.path : `${req.protocol}//${String(req.getHeader("host") ?? req.host)}${req.path}`;
}

/** The `traceparent` `req` went out with, read from the header block it
 * sent, or `undefined` before its headers are sent or when they held
 * none. */
function sentTraceparent(req: http.ClientRequest): string | undefined {
  if (!req.headersSent) return undefined;
  const block = (req as { readonly _header?: unknown })._header;
  if (typeof block === "string") return traceparentIn(block);
  const value = req.getHeader(TRACEPARENT);
  return value === undefined ? undefined : Array.isArray(value) ? value.join(", ") : String(value);
}

/** The hook `req`'s `write`, `end`, and `flushHeaders` call before the
 * original: the moment its headers are sent, a request to the world that
 * carries no `traceparent` gets nukadoko's, counted once it went out
 * (this file's header). Headers given as an array are already sent when
 * the request is created, so such a request goes as it was. */
function stampAtSend(req: http.ClientRequest, rec: ChannelRecorder): { before(): void; after(): void } {
  let draft: { readonly value: string; sent(): void } | undefined;
  return {
    before() {
      if (draft !== undefined || req.headersSent || req.method === "CONNECT" || req.hasHeader(TRACEPARENT)) return;
      const url = clientRequestUrl(req);
      if (typeof rec.draftTraceparent === "function") draft = rec.draftTraceparent(url);
      else if (typeof rec.traceparentFor === "function") {
        const value = rec.traceparentFor(url);
        if (value !== undefined) draft = { value, sent: () => {} };
      }
      if (draft !== undefined) req.setHeader(TRACEPARENT, draft.value);
    },
    after() {
      if (draft !== undefined && sentTraceparent(req) === draft.value) draft.sent();
    },
  };
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
  const stamp = stampAtSend(req, rec);
  // A stamp that fails leaves the request as it was.
  const sending = <T>(send: () => T): T => {
    try {
      stamp.before();
    } catch {
      // As above.
    }
    try {
      return send();
    } finally {
      try {
        stamp.after();
      } catch {
        // As above.
      }
    }
  };

  const originalWrite = req.write;
  req.write = function (this: http.ClientRequest, chunk: unknown, ...rest: unknown[]): boolean {
    const bytes = chunkBytes(chunk, rest[0]);
    if (bytes !== undefined) requestBody.add(bytes);
    return sending(() => (originalWrite as (...a: unknown[]) => boolean).call(this, chunk, ...rest));
  } as typeof req.write;
  const originalEnd = req.end;
  req.end = function (this: http.ClientRequest, chunk?: unknown, ...rest: unknown[]): http.ClientRequest {
    const bytes = chunkBytes(chunk, rest[0]);
    if (bytes !== undefined) requestBody.add(bytes);
    return sending(() => (originalEnd as (...a: unknown[]) => http.ClientRequest).call(this, chunk, ...rest));
  } as typeof req.end;
  const originalFlushHeaders = req.flushHeaders;
  req.flushHeaders = function (this: http.ClientRequest): void {
    sending(() => originalFlushHeaders.call(this));
  };

  const url = (): string => clientRequestUrl(req);
  const sentField = (): { traceparent?: string; traceparent_sent_to?: readonly string[] } => {
    const sent = sentTraceparent(req);
    const origin = originOf(url());
    return sent === undefined ? {} : { traceparent: sent, traceparent_sent_to: origin === undefined ? [] : [origin] };
  };
  const line = (fields: { readonly error?: string; readonly response?: RawBody }): ChannelHttpLine => ({
    method: req.method,
    url: url(),
    status,
    duration_ms: durationMs ?? Math.round(performance.now() - startedAt),
    via,
    ...sentField(),
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

/** Connections not accounted for when they connected, so a WebSocket that
 * opens over one can account for it later. Held weakly: the set only
 * names sockets, and a socket that is gone or accounted for leaves it the
 * next time it is read. */
const unownedConnections = new Set<WeakRef<net.Socket>>();

/** Accounts for the connection a global `WebSocket` opened over, found by
 * the local address undici publishes on `undici:websocket:open`: from then
 * on the socket's traffic is websocket.jsonl's frames. */
function ownWebSocketConnection(message: unknown): void {
  const local = (message as { address?: { address?: unknown; port?: unknown } } | undefined)?.address;
  if (local === undefined || typeof local.port !== "number") return;
  for (const ref of unownedConnections) {
    const socket = ref.deref();
    if (socket === undefined || socket.destroyed || sockets.get(socket)?.owned !== false) {
      unownedConnections.delete(ref);
    } else if (socket.localPort === local.port && socket.localAddress === local.address) {
      ownSocket(socket);
      unownedConnections.delete(ref);
    }
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
    if (!use.owned) unownedConnections.add(new WeakRef(this));
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

// A datagram has no response to record, so a send can only be marked,
// once per address. Marked after `send` returns, so arguments it rejects
// send nothing and name nothing, the way a refused `connect` is still a
// connection the step opened.
function installDgram(): void {
  const proto = dgram.Socket.prototype as unknown as Record<"send", (...args: unknown[]) => unknown>;
  const send = proto.send;
  proto.send = sameShape(function (this: dgram.Socket, ...args: unknown[]): unknown {
    const rec = channelRecorder();
    const result = send.apply(this, args);
    if (rec !== undefined) rec.markUnmeasured({ kind: "socket", detail: `send to ${datagramAddress(this, args)}` });
    return result;
  }, send);
}

/** The `<host>:<port>` a `send` call goes to: the connected peer, or
 * what the call names, read the way Node reads an unconnected socket's
 * two forms (`send(msg, port, address)` and `send(msg, offset, length,
 * port, address)`). Node sends to the loopback address when none is
 * given. A socket still connecting refuses a send, so it never reaches
 * here. */
function datagramAddress(socket: dgram.Socket, args: readonly unknown[]): string {
  try {
    let peer: { address: string; port: number } | undefined;
    try {
      peer = socket.remoteAddress();
    } catch {
      peer = undefined;
    }
    if (peer !== undefined) return `${peer.address}:${peer.port}`;
    const [, offset, length, port, address] = args;
    const withRange = Boolean(address) || (Boolean(port) && typeof port !== "function");
    const [to, host] = withRange ? [port, address] : [offset, length];
    const loopback = (socket as { type?: unknown }).type === "udp6" ? "::1" : "127.0.0.1";
    return `${typeof host === "string" ? host : loopback}:${String(to)}`;
  } catch {
    // An argument whose conversion throws the second time it is read.
    return "an address nukadoko could not read";
  }
}

const webSocketNumbers = new WeakMap<object, number>();
let lastWebSocketNumber = 0;

function webSocketNumber(socket: object): number {
  let number = webSocketNumbers.get(socket);
  if (number === undefined) {
    lastWebSocketNumber += 1;
    number = lastWebSocketNumber;
    webSocketNumbers.set(socket, number);
  }
  return number;
}

function recordWebSocket(rec: Partial<ChannelRecorder> | undefined, seen: () => WebSocketSeen | undefined): void {
  if (typeof rec?.webSocketEvent !== "function") return;
  try {
    const event = seen();
    if (event !== undefined) rec.webSocketEvent(event);
  } catch {
    // A missing line, never a failed send or a lost event.
  }
}

// The global `WebSocket` is undici's. A frame sent is the sending step's,
// read from the step's scope as a request is. An open, a frame received,
// and a close arrive in the context the socket was made in, often a
// fixture's, so they belong to the step running when they arrive. Both are
// caught on the prototype (`send`, and `dispatchEvent`, which undici calls
// for every event), so a socket keeps its own class and `instanceof`.
// Measured on Node 22.23.4 and 24.22.1.
function installWebSocket(): void {
  const constructor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof constructor !== "function") return;
  const proto = constructor.prototype as Record<"send" | "dispatchEvent", (...args: unknown[]) => unknown>;
  const send = proto.send;
  proto.send = sameShape(function (this: WebSocket, ...args: unknown[]): unknown {
    const result = send.apply(this, args);
    // A socket that is closing or closed drops the data without a throw,
    // so only a send on an open socket is a frame that went.
    if (this.readyState === 1) {
      recordWebSocket(channelRecorder() ?? runningRecorder(), () => ({ event: "sent", socket: webSocketNumber(this), url: this.url, data: args[0] }));
    }
    return result;
  }, send);
  const dispatchEvent = proto.dispatchEvent;
  proto.dispatchEvent = sameShape(function (this: WebSocket, ...args: unknown[]): unknown {
    recordWebSocket(runningRecorder(), () => {
      const event = args[0];
      if (!(event instanceof Event)) return undefined;
      const socket = { socket: webSocketNumber(this), url: this.url };
      if (event.type === "open") return { event: "open", ...socket, protocol: this.protocol };
      if (event.type === "message") return { event: "received", ...socket, data: (event as MessageEvent).data };
      if (event.type === "close") return { event: "close", ...socket, code: (event as CloseEvent).code, reason: (event as CloseEvent).reason };
      return undefined;
    });
    return dispatchEvent.apply(this, args);
  }, dispatchEvent);
  diagnosticsChannel.subscribe("undici:websocket:open", ownWebSocketConnection);
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
  installDgram();
  installWebSocket();
  syncBuiltinESMExports();
}
