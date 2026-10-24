import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import {
  completeLines,
  newSpanId,
  newTraceId,
  originOf,
  sliceProgramLog,
  stampsUrl,
  traceparentOf,
} from "../src/context/trace-context.js";

// Responsibility: src/context/trace-context.ts, the pure rules of trace
// context: the ids and the `traceparent` value, which URLs are the
// world's origin, and which lines of the program's log are a step's.

const hex = (size: number) => gs.text({ alphabet: "0123456789abcdef", minSize: size, maxSize: size });

describe("ids and traceparent", () => {
  it("makes ids of the W3C lengths from the random bytes, drawing again while they are all zeros", () =>
    hegel.test((tc) => {
      for (const [make, size] of [
        [newTraceId, 16],
        [newSpanId, 8],
      ] as const) {
        const zeros = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
        const bytes = Buffer.from(tc.draw(gs.binary({ minSize: size, maxSize: size }).filter((drawn) => drawn.some((byte) => byte !== 0))));
        let calls = 0;
        const id = make((n) => (calls++ < zeros ? Buffer.alloc(n) : bytes));
        expect(id).toBe(bytes.toString("hex"));
        expect(id).toHaveLength(size * 2);
        expect(calls).toBe(zeros + 1);
      }
    }));

  it("writes version 00 and the sampled flag around the two ids", () =>
    hegel.test((tc) => {
      const trace = tc.draw(hex(32));
      const span = tc.draw(hex(16));
      expect(traceparentOf(trace, span)).toBe(`00-${trace}-${span}-01`);
    }));

  it("makes a different id each time from the system's random source", () => {
    const traces = new Set(Array.from({ length: 50 }, () => newTraceId()));
    const spans = new Set(Array.from({ length: 50 }, () => newSpanId()));
    expect(traces.size).toBe(50);
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

// Lines from small pieces: a line may carry the trace id, this step's
// span, another span, or none of them, between filler text that cannot
// spell an id.
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const OTHERS = ["a1b2c3d4e5f60718", "1122334455667788"];
const filler = gs.text({ alphabet: "GET /[] -=xyz", maxSize: 8 });
const token = gs.sampledFrom(["", TRACE, SPAN, ...OTHERS, traceparentOf(TRACE, SPAN), traceparentOf(TRACE, OTHERS[0]!)]);
const line = gs.tuples(filler, token, filler, token).map(([a, b, c, d]) => `${a}${b}${c}${d}`);
const ids = { traceId: TRACE, spanId: SPAN, otherSpans: new Set(OTHERS) };

describe("sliceProgramLog", () => {
  it("keeps every line with the step's span, and each line with the trace id and no other span, in order", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(line, { maxSize: 12 }));
      const expected = lines.filter(
        (text) => text.includes(SPAN) || (text.includes(TRACE) && !OTHERS.some((other) => text.includes(other))),
      );
      expect(sliceProgramLog(lines, ids)).toEqual(expected);
    }));

  it("never keeps a line that carries neither id, or only another step's span", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(line, { maxSize: 12 }));
      for (const kept of sliceProgramLog(lines, ids)) {
        expect(kept.includes(SPAN) || kept.includes(TRACE)).toBe(true);
        if (!kept.includes(SPAN)) expect(OTHERS.some((other) => kept.includes(other))).toBe(false);
      }
    }));

  it("slices a log read in parts the same as the whole: a line's place in the window does not change whose it is", () =>
    hegel.test((tc) => {
      const first = tc.draw(gs.arrays(line, { maxSize: 8 }));
      const second = tc.draw(gs.arrays(line, { maxSize: 8 }));
      expect(sliceProgramLog([...first, ...second], ids)).toEqual([...sliceProgramLog(first, ids), ...sliceProgramLog(second, ids)]);
    }));

  it("keeps a Rails line tagged with the whole traceparent, and leaves out another step's", () => {
    expect(
      sliceProgramLog(
        [
          `[${traceparentOf(TRACE, SPAN)}] Started GET "/rooms/1" for 127.0.0.1`,
          `[${traceparentOf(TRACE, OTHERS[0]!)}] Completed 200 OK in 3ms`,
          `[trace=${TRACE}] Enqueued job`,
          "Listening on http://127.0.0.1:3100",
        ],
        ids,
      ),
    ).toEqual([`[${traceparentOf(TRACE, SPAN)}] Started GET "/rooms/1" for 127.0.0.1`, `[trace=${TRACE}] Enqueued job`]);
  });
});

describe("completeLines", () => {
  it("returns the lines before the last line end, and holds back a line still being written", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ alphabet: "ab \r", maxSize: 5 }), { maxSize: 6 }));
      const partial = tc.draw(gs.text({ alphabet: "ab ", maxSize: 5 }));
      const text = lines.map((entry) => `${entry}\n`).join("") + partial;
      expect(completeLines(text)).toEqual(lines);
    }));
});
