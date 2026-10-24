import { randomBytes } from "node:crypto";

// Responsibility: the W3C trace context nukadoko puts on the requests a
// step sends to the world (docs/spec.md "Trace context and the program's
// log"): one trace id per step boundary, a span id per request, the
// `traceparent` value they make, which URLs get one, and which trace id a
// line of the program's log carries. Pure: no I/O and no state.
// observed.ts holds each boundary's trace id; channels.ts, http-log.ts,
// and browser-trace.ts put the header on a request; program-log-slice.ts
// reads the log.
//
// A line belongs to the step whose trace id it carries, wherever and
// whenever it appears in the log: nothing about when the line was written
// or read decides it, so a line that arrives after its step ended is still
// that step's, and never the next step's. Every trace id of one world
// starts with the same eight characters, made for that world, so the trace
// id a line carries is the first place in it where those characters begin
// 32 hexadecimal ones. That rule needs no list of the ids: a worker that
// knows only its own steps' ids and the parent that knows them all read
// the same id from the same line, so a line is never one step's in a
// slice and another step's afterwards.
//
// Only the world's own origin gets the header. A request to another
// origin is a third party's (a CDN, a payment provider), and a header it
// did not expect can change what it does: a browser sends a CORS preflight
// before a cross-origin request with a header outside the safelisted set,
// and a server that answers only simple CORS requests then refuses it.
// One widening: a world at `localhost` also answers at every name below
// `localhost` with the same scheme and port. Such a name resolves to the
// loopback address (RFC 6761), so the request reaches the port nukadoko
// gave the program, and a project gives each person in a scenario a host
// name of their own there so their cookies stay apart.

/** The header's name, as W3C Trace Context writes it. */
export const TRACEPARENT = "traceparent";

/** How many hexadecimal characters a world's trace id prefix holds. */
export const TRACE_PREFIX_LENGTH = 8;

const TRACE_ID_LENGTH = 32;

function isHex(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
}

/** `bytes` random bytes as hexadecimal, drawn again while `whole(hex)` is
 * all zeros, which W3C Trace Context reserves as an invalid id. */
function nonZeroHex(bytes: number, random: (size: number) => Buffer, whole: (hex: string) => string = (hex) => hex): string {
  for (;;) {
    const hex = random(bytes).toString("hex");
    if (!/^0+$/.test(whole(hex))) return hex;
  }
}

/** A new world's trace id prefix: eight hexadecimal characters. */
export function newTracePrefix(random: (size: number) => Buffer = randomBytes): string {
  return random(TRACE_PREFIX_LENGTH / 2).toString("hex");
}

/** A new trace id, one per step boundary: the world's prefix, then random
 * hexadecimal characters to make 32. */
export function newTraceId(prefix: string, random: (size: number) => Buffer = randomBytes): string {
  return prefix + nonZeroHex((TRACE_ID_LENGTH - prefix.length) / 2, random, (hex) => prefix + hex);
}

/** A new span id: one per request a boundary stamps. */
export function newSpanId(random: (size: number) => Buffer = randomBytes): string {
  return nonZeroHex(8, random);
}

/** The `traceparent` value: version 00, and the sampled flag set, so a
 * program that records traces records this one. */
export function traceparentOf(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/** The trace id `line` carries for the world whose ids start with
 * `prefix`, in lowercase: the first place in the line, in either case,
 * where the prefix begins 32 hexadecimal characters. `undefined` when no
 * such place exists (module header). */
export function traceIdIn(line: string, prefix: string): string | undefined {
  const text = line.toLowerCase();
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
    if (at + TRACE_ID_LENGTH > text.length) return undefined;
    let hex = true;
    for (let index = at + prefix.length; index < at + TRACE_ID_LENGTH && hex; index += 1) hex = isHex(text.charCodeAt(index));
    if (hex) return text.slice(at, at + TRACE_ID_LENGTH);
  }
  return undefined;
}

/** The origin of `url` (`http://localhost:41873`), or `undefined` for a
 * URL that does not parse or has no origin of its own (`file:`, `data:`). */
export function originOf(url: string | undefined, base?: string): string | undefined {
  if (url === undefined) return undefined;
  try {
    const origin = new URL(url, base).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Whether a request to `target`, resolved against `base` when it is
 * relative, goes to the world at `origin`: the same scheme, host, and
 * port, with a scheme's default port and the host's case normalized the
 * way `URL` normalizes them, or, for a world at `localhost`, a name below
 * `localhost` at the same scheme and port (module header). */
export function stampsUrl(origin: string, target: string, base?: string): boolean {
  let url: URL;
  let world: URL;
  try {
    url = new URL(target, base);
    world = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin === origin) return true;
  return world.hostname === "localhost" && url.hostname.endsWith(".localhost") && url.protocol === world.protocol && url.port === world.port;
}

/** The complete lines in `bytes`, decoded as UTF-8, and how many bytes
 * they took. What follows the last line end is a line still being
 * written, so it is left for the next read. A line end never falls inside
 * a multi-byte character, so cutting there never splits one. */
export function completeLines(bytes: Uint8Array): { readonly lines: string[]; readonly consumed: number } {
  const end = bytes.lastIndexOf(0x0a);
  if (end === -1) return { lines: [], consumed: 0 };
  return { lines: Buffer.from(bytes.buffer, bytes.byteOffset, end).toString("utf8").split("\n"), consumed: end + 1 };
}
