import { randomBytes } from "node:crypto";

// Responsibility: the W3C trace context nukadoko puts on the requests a
// step sends to the world (docs/spec.md "Trace context and the program's
// log"): one trace id per scenario, one span id per step boundary, the
// `traceparent` value they make, which URLs get one, and which lines of
// the program's log belong to a step. Pure: no I/O and no state. observed.ts holds each boundary's
// ids; channels.ts, http-log.ts, and browser-trace.ts put the header on a
// request; program-log-slice.ts reads the log.
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

/** A trace id is 32 lowercase hexadecimal characters, a span id 16, and
 * neither is all zeros, which W3C Trace Context reserves as invalid. */
function nonZeroHex(bytes: number, random: (size: number) => Buffer): string {
  for (;;) {
    const hex = random(bytes).toString("hex");
    if (!/^0+$/.test(hex)) return hex;
  }
}

/** A new trace id: one per scenario execution. */
export function newTraceId(random: (size: number) => Buffer = randomBytes): string {
  return nonZeroHex(16, random);
}

/** A new span id: one per step boundary. */
export function newSpanId(random: (size: number) => Buffer = randomBytes): string {
  return nonZeroHex(8, random);
}

/** The `traceparent` value: version 00, and the sampled flag set, so a
 * program that records traces records this one. */
export function traceparentOf(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
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

/** The ids `sliceProgramLog` selects a step's lines by. */
export interface SliceIds {
  readonly traceId: string;
  readonly spanId: string;
  /** Every other span id this trace gave a boundary: the scenario's other
   * steps and its hooks. */
  readonly otherSpans: ReadonlySet<string>;
}

/** The lines of `lines` that belong to the step `ids` names, in order:
 * each line that carries its span id, and each line that carries the
 * trace id and no other span id of the trace. The second rule is for a
 * program that tags a line with the trace id alone; the caller passes
 * only the lines the program wrote while the step ran, so such a line is
 * this step's. A line with neither id is no step's: the program wrote it
 * for no request nukadoko sent, or it does not tag its lines. */
export function sliceProgramLog(lines: readonly string[], ids: SliceIds): string[] {
  return lines.filter((line) => {
    if (line.includes(ids.spanId)) return true;
    if (!line.includes(ids.traceId)) return false;
    for (const other of ids.otherSpans) if (line.includes(other)) return false;
    return true;
  });
}

/** The complete lines of `text`. A last line with no line end was still
 * being written when the text was read, so it is no line yet. */
export function completeLines(text: string): string[] {
  const end = text.lastIndexOf("\n");
  return end === -1 ? [] : text.slice(0, end).split("\n");
}
