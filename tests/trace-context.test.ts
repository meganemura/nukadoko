import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import {
  completeLines,
  newSpanId,
  newTraceId,
  newTracePrefix,
  originOf,
  stampsUrl,
  TRACE_PREFIX_LENGTH,
  traceIdIn,
  traceparentIds,
  traceparentOf,
} from "../src/context/trace-context.js";

// Responsibility: src/context/trace-context.ts, the pure rules of trace
// context: the ids and the `traceparent` value, which URLs are the
// world's origin, which trace id a line of the program's log carries, and
// how the log's bytes become lines.

const hex = (size: number) => gs.text({ alphabet: "0123456789abcdef", minSize: size, maxSize: size });

describe("ids and traceparent", () => {
  it("makes a prefix, and span ids of the W3C length, from the random bytes, drawing a span again while it is all zeros", () =>
    hegel.test((tc) => {
      const prefixBytes = Buffer.from(tc.draw(gs.binary({ minSize: TRACE_PREFIX_LENGTH / 2, maxSize: TRACE_PREFIX_LENGTH / 2 })));
      expect(newTracePrefix(() => prefixBytes)).toBe(prefixBytes.toString("hex"));
      const zeros = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const bytes = Buffer.from(tc.draw(gs.binary({ minSize: 8, maxSize: 8 }).filter((drawn) => drawn.some((byte) => byte !== 0))));
      let calls = 0;
      const id = newSpanId((n) => (calls++ < zeros ? Buffer.alloc(n) : bytes));
      expect(id).toBe(bytes.toString("hex"));
      expect(calls).toBe(zeros + 1);
    }));

  it("makes a trace id of 32 characters that starts with the world's prefix, never all zeros", () =>
    hegel.test((tc) => {
      const prefix = tc.draw(gs.oneOf(hex(TRACE_PREFIX_LENGTH), gs.just("00000000")));
      const zeros = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const bytes = Buffer.from(tc.draw(gs.binary({ minSize: 12, maxSize: 12 }).filter((drawn) => drawn.some((byte) => byte !== 0))));
      let calls = 0;
      const id = newTraceId(prefix, (n) => (calls++ < zeros && prefix === "00000000" ? Buffer.alloc(n) : bytes));
      expect(id).toBe(prefix + bytes.toString("hex"));
      expect(id).toHaveLength(32);
      expect(id).not.toMatch(/^0+$/);
    }));

  it("writes version 00 and the sampled flag around the two ids", () =>
    hegel.test((tc) => {
      const trace = tc.draw(hex(32));
      const span = tc.draw(hex(16));
      expect(traceparentOf(trace, span)).toBe(`00-${trace}-${span}-01`);
    }));

  it("reads back, from one parse, the two ids a traceparent was made of", () =>
    hegel.test((tc) => {
      const trace = tc.draw(hex(32).filter((id) => !/^0+$/.test(id)));
      const span = tc.draw(hex(16).filter((id) => !/^0+$/.test(id)));
      expect(traceparentIds(traceparentOf(trace, span))).toEqual({ traceId: trace, spanId: span });
    }));

  it("reads the ids of any well-formed traceparent in lowercase, whatever its version, flags, case, and surrounding space", () =>
    hegel.test((tc) => {
      const anyCase = (size: number) => gs.text({ alphabet: "0123456789abcdefABCDEF", minSize: size, maxSize: size });
      const [version, trace, span, flags] = [tc.draw(anyCase(2)), tc.draw(anyCase(32)), tc.draw(anyCase(16)), tc.draw(anyCase(2))];
      const space = tc.draw(gs.sampledFrom(["", " ", "\t", " \n"]));
      expect(traceparentIds(`${space}${version}-${trace}-${span}-${flags}${space}`)).toEqual({ traceId: trace.toLowerCase(), spanId: span.toLowerCase() });
    }));

  it("reads no ids from a value one character away from a traceparent, or from no value", () =>
    hegel.test((tc) => {
      const value = traceparentOf(tc.draw(hex(32)), tc.draw(hex(16)));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: value.length - 1 }));
      const broken = tc.draw(
        gs.sampledFrom([
          value.slice(0, at) + value.slice(at + 1),
          value.slice(0, at) + "a" + value.slice(at),
          value.slice(0, at) + tc.draw(gs.sampledFrom(["g", "Z", "_", "."])) + value.slice(at + 1),
          value.slice(0, at) + (value[at] === "-" ? "0" : "-") + value.slice(at + 1),
        ]),
      );
      expect(traceparentIds(broken)).toBeNull();
      expect(traceparentIds(null)).toBeNull();
    }));

  it("makes a different id each time from the system's random source", () => {
    const prefix = newTracePrefix();
    const traces = new Set(Array.from({ length: 50 }, () => newTraceId(prefix)));
    const spans = new Set(Array.from({ length: 50 }, () => newSpanId()));
    expect(prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(traces.size).toBe(50);
    expect([...traces].every((id) => id.startsWith(prefix))).toBe(true);
    expect(spans.size).toBe(50);
  });
});

const scheme = gs.sampledFrom(["http", "https"]);
const host = gs.sampledFrom(["localhost", "LocalHost", "aki.localhost", "127.0.0.1", "app.example", "App.Example", "[::1]"]);
const port = gs.oneOf(gs.just(undefined), gs.integers({ minValue: 1, maxValue: 65535 }));
const pathPart = gs.text({ alphabet: "abc/?=&#%-", maxSize: 12 });

function urlOf(parts: { scheme: string; host: string; port: number | undefined; path: string }): string {
  return `${parts.scheme}://${parts.host}${parts.port === undefined ? "" : `:${parts.port}`}/${parts.path}`;
}

/** The port a URL with these parts reaches, a scheme's default included. */
function effectivePort(parts: { scheme: string; port: number | undefined }): number {
  return parts.port ?? (parts.scheme === "https" ? 443 : 80);
}

describe("stampsUrl", () => {
  it("stamps a URL exactly when its scheme, host (in any case), and port equal the world's, or it is a name below a localhost world", () =>
    hegel.test((tc) => {
      const world = { scheme: tc.draw(scheme), host: tc.draw(host), port: tc.draw(port), path: "" };
      const target = { scheme: tc.draw(scheme), host: tc.draw(host), port: tc.draw(port), path: tc.draw(pathPart) };
      const origin = originOf(urlOf(world))!;
      const samePlace = world.scheme === target.scheme && effectivePort(world) === effectivePort(target);
      const worldHost = world.host.toLowerCase();
      const targetHost = target.host.toLowerCase();
      const stamped = samePlace && (worldHost === targetHost || (worldHost === "localhost" && targetHost.endsWith(".localhost")));
      expect(stampsUrl(origin, urlOf(target))).toBe(stamped);
    }));

  it("stamps every path-relative URL resolved against the world's own URL", () =>
    hegel.test((tc) => {
      const world = urlOf({ scheme: tc.draw(scheme), host: tc.draw(host), port: tc.draw(port), path: tc.draw(pathPart) });
      // A first character other than `/`: `//host/path` names a host of
      // its own, which the example below covers.
      const relative = `/${tc.draw(gs.text({ alphabet: "abc?=&#%-", minSize: 1, maxSize: 4 }))}${tc.draw(pathPart)}`;
      expect(stampsUrl(originOf(world)!, relative, world)).toBe(true);
    }));

  it("stamps nothing that does not parse or has no origin of its own", () => {
    const origin = "http://localhost:41873";
    expect(stampsUrl(origin, "not a url")).toBe(false);
    expect(stampsUrl(origin, "/relative")).toBe(false);
    expect(stampsUrl(origin, "//elsewhere.example/x", "http://localhost:41873/")).toBe(false);
    expect(stampsUrl(origin, "data:text/plain,hi")).toBe(false);
    expect(originOf("file:///tmp/x")).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
    expect(stampsUrl(origin, "http://localhost:41873/api?x=1")).toBe(true);
    expect(stampsUrl("http://localhost", "http://LOCALHOST:80/")).toBe(true);
    expect(stampsUrl(origin, "http://127.0.0.1:41873/")).toBe(false);
    expect(stampsUrl(origin, "ws://localhost:41873/")).toBe(false);
    expect(stampsUrl(origin, "http://aki.localhost:41873/rooms")).toBe(true);
    expect(stampsUrl(origin, "http://aki.localhost:41874/rooms")).toBe(false);
    expect(stampsUrl("http://aki.localhost:41873", "http://localhost:41873/")).toBe(false);
    expect(stampsUrl("https://app.example", "https://cdn.app.example/")).toBe(false);
  });
});

// Lines from small pieces: a line may carry ids of this world in either
// case, an id of another world, a span id, or nothing, between filler
// text that cannot spell an id.
const PREFIX = "4bf92f35";
const ONE = `${PREFIX}77b34da6a3ce929d0e0e4736`;
const TWO = `${PREFIX}0123456789abcdef01234567`;
const ELSEWHERE = "a1b2c3d477b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const filler = gs.text({ alphabet: "GT /[] -=xyz", maxSize: 8 });
const token = gs.sampledFrom([
  "",
  ONE,
  TWO,
  ONE.toUpperCase(),
  ELSEWHERE,
  SPAN,
  PREFIX,
  `${PREFIX}77b3`,
  traceparentOf(ONE, SPAN),
  traceparentOf(TWO, SPAN),
  traceparentOf(ELSEWHERE, SPAN),
]);
const line = gs.tuples(filler, token, filler, token).map(([a, b, c, d]) => `${a}${b}${c}${d}`);

/** A second statement of the rule, as a regular expression. */
function reference(text: string, prefix: string): string | undefined {
  return new RegExp(`${prefix}[0-9a-f]{${32 - prefix.length}}`, "i").exec(text)?.[0].toLowerCase();
}

describe("traceIdIn", () => {
  it("reads the first place in a line, in either case, where the world's prefix begins 32 hexadecimal characters", () =>
    hegel.test((tc) => {
      const text = tc.draw(line);
      expect(traceIdIn(text, PREFIX)).toBe(reference(text, PREFIX));
    }));

  it("reads no id from a line that carries no trace id of the world: a span id, a short run, or another world's id", () =>
    hegel.test((tc) => {
      const pieces = tc.draw(gs.arrays(gs.oneOf(filler, gs.sampledFrom([SPAN, PREFIX, `${PREFIX}77b3`, ELSEWHERE, traceparentOf(ELSEWHERE, SPAN)])), { maxSize: 6 }));
      // Joined by a space: a prefix run straight into another world's id
      // spells an id of this world, which is the rule, not a line without one.
      expect(traceIdIn(pieces.join(" "), PREFIX)).toBeUndefined();
    }));

  it("gives a line carrying several of a world's trace ids to the leftmost one only", () =>
    hegel.test((tc) => {
      const ids = tc.draw(gs.arrays(gs.sampledFrom([ONE, TWO, ONE.toUpperCase()]), { minSize: 1, maxSize: 4 }));
      const text = ids.map((id) => `[${tc.draw(filler)}] ${id}`).join(" ");
      expect(traceIdIn(text, PREFIX)).toBe(ids[0]!.toLowerCase());
    }));

  it("reads a Rails line tagged with the whole traceparent, and an OpenTelemetry line with its own span id", () => {
    expect(traceIdIn(`[${traceparentOf(ONE, SPAN)}] Started GET "/rooms/1" for 127.0.0.1`, PREFIX)).toBe(ONE);
    expect(traceIdIn(`{"trace_id":"${TWO}","span_id":"5f2c1b0a9e8d7c6b","msg":"Completed 200 OK"}`, PREFIX)).toBe(TWO);
    expect(traceIdIn("Listening on http://127.0.0.1:3100", PREFIX)).toBeUndefined();
  });
});

const encoder = new TextEncoder();

describe("completeLines", () => {
  it("returns the lines before the last line end, and holds back the bytes of a line still being written", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ alphabet: "ab \ré", maxSize: 5 }), { maxSize: 6 }));
      const partial = tc.draw(gs.text({ alphabet: "ab é", maxSize: 5 }));
      const whole = lines.map((entry) => `${entry}\n`).join("");
      const bytes = encoder.encode(whole + partial);
      expect(completeLines(bytes)).toEqual({ lines, consumed: encoder.encode(whole).length });
    }));

  it("reads the same lines from a log however its bytes were split into reads, a multi-byte character cut included", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ alphabet: "aé漢🙂 ", maxSize: 6 }), { maxSize: 6 }));
      const bytes = encoder.encode(lines.map((entry) => `${entry}\n`).join(""));
      const cuts = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { maxSize: 5 })).sort((a, b) => a - b);
      const read: string[] = [];
      let carry = new Uint8Array(0);
      let at = 0;
      for (const cut of [...cuts, bytes.length]) {
        const chunk = new Uint8Array([...carry, ...bytes.subarray(at, cut)]);
        at = cut;
        const { lines: found, consumed } = completeLines(chunk);
        read.push(...found);
        carry = chunk.subarray(consumed);
      }
      expect(read).toEqual(lines);
      expect(carry.length).toBe(0);
    }));
});
