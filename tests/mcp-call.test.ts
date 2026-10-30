import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { createTraceTally } from "../src/execution-events/tally.js";
import { BODY_CAP } from "../src/context/kept-text.js";
import { mcpLineOf, outgoingOf, stampTraceparent, traceparentIn } from "../src/context/mcp-call.js";
import { measureMcp } from "../src/context/measure-mcp.js";

// Responsibility: the pure parts of a measured MCP call. Stamping
// `params._meta.traceparent` adds that one key and keeps everything else
// (and a caller's own value); a call's line never holds a secret its
// params or result held, and is bounded the way a body is; the tally
// counts each MCP call that no stamped request carried as unbounded; and
// measureMcp passes a message through untouched outside a step. The end to
// end behavior is tests/mcp-measured.test.ts.

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const key = gs.text({ minSize: 1, maxSize: 6, alphabet: "abcxyz" });
const leaf = gs.oneOf(
  gs.integers({ minValue: -50, maxValue: 50 }).map((value) => value as unknown),
  gs.text({ maxSize: 10, alphabet: "abc ." }).map((value) => value as unknown),
  gs.booleans().map((value) => value as unknown),
);
const params = gs.maps(key, leaf, { maxSize: 4 }).map((map) => Object.fromEntries(map) as Record<string, unknown>);
const meta = gs.maps(gs.sampledFrom(["progressToken", "x.example/tag"]), leaf, { maxSize: 2 }).map((map) => Object.fromEntries(map) as Record<string, unknown>);

describe("stampTraceparent", () => {
  it("adds only params._meta.traceparent, and leaves the message it was given as it was", () =>
    hegel.test((tc) => {
      const withMeta = tc.draw(gs.booleans());
      const given = { jsonrpc: "2.0", id: tc.draw(gs.integers({ minValue: 1, maxValue: 9 })), method: "tools/call", params: { ...tc.draw(params), ...(withMeta ? { _meta: tc.draw(meta) } : {}) } };
      const before = structuredClone(given);
      const { message, stamped } = stampTraceparent(given, TRACEPARENT);
      expect(given).toEqual(before);
      expect(stamped).toBe(true);
      expect(traceparentIn(message)).toBe(TRACEPARENT);
      const { _meta, ...rest } = message.params as { _meta: Record<string, unknown> };
      const { traceparent: _value, ...metaRest } = _meta;
      const { _meta: givenMeta, ...givenRest } = before.params as { _meta?: Record<string, unknown> };
      expect(rest).toEqual(givenRest);
      expect(metaRest).toEqual(givenMeta ?? {});
      expect({ ...message, params: undefined }).toEqual({ ...before, params: undefined });
    }));

  it("keeps a caller's own traceparent, and stamps no positional params", () => {
    const own = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a", _meta: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } } };
    expect(stampTraceparent(own, TRACEPARENT)).toEqual({ message: own, stamped: false });
    const positional = { jsonrpc: "2.0", id: 2, method: "x", params: [1, 2] };
    expect(stampTraceparent(positional, TRACEPARENT)).toEqual({ message: positional, stamped: false });
    expect(traceparentIn(stampTraceparent({ jsonrpc: "2.0", method: "notifications/initialized" }, TRACEPARENT).message)).toBe(TRACEPARENT);
  });
});

describe("outgoingOf", () => {
  it("tells a request from a notification and from the client's own answer", () => {
    expect(outgoingOf({ jsonrpc: "2.0", id: 3, method: "tools/list" })).toEqual({ kind: "request", id: 3, method: "tools/list" });
    expect(outgoingOf({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} })).toEqual({ kind: "notification", method: "notifications/cancelled" });
    expect(outgoingOf({ jsonrpc: "2.0", id: 3, result: {} })).toEqual({ kind: "other" });
  });
});

describe("mcpLineOf", () => {
  it("never keeps a secret the params or the result held, and keeps at most a body's cap of each", () =>
    hegel.test((tc) => {
      const secret = `tok_${tc.draw(gs.text({ minSize: 6, maxSize: 12, alphabet: "qrstuv" }))}`;
      const padding = "n".repeat(tc.draw(gs.integers({ minValue: 0, maxValue: 3 * BODY_CAP })));
      const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_note", arguments: { text: `${padding}${secret}`, token: secret } } };
      const answer = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `${secret}${padding}` }] } };
      const line = mcpLineOf({ message, end: { answer, duration_ms: 3 } }, [], [{ name: "TOKEN", value: secret }]);
      const text = JSON.stringify(line);
      expect(text).not.toContain(secret);
      for (const kept of [line.params!, line.result!]) {
        expect(Buffer.byteLength(kept.text!, "utf8")).toBeLessThanOrEqual(BODY_CAP);
        expect(kept.truncated === true).toBe(kept.bytes! > BODY_CAP);
      }
      expect(line.tool).toBe("add_note");
    }));

  it("names a tool's error report, a JSON-RPC error, and a call left unanswered", () => {
    const call = { jsonrpc: "2.0", id: "a", method: "resources/read", params: { uri: "notes://all" } };
    expect(mcpLineOf({ message: call, end: { answer: { id: "a", result: { content: [], isError: true } }, duration_ms: 1 } }, [], [])).toMatchObject({
      uri: "notes://all",
      is_error: true,
    });
    expect(mcpLineOf({ message: call, end: { answer: { id: "a", error: { code: -32602, message: "bad\n  at stack" } }, duration_ms: 1 } }, [], [])).toMatchObject({
      error: { code: -32602, message: "bad" },
    });
    const open = mcpLineOf({ message: call, end: { unanswered: "step" } }, ["http://localhost:3000"], []);
    expect(open).toMatchObject({ unanswered: "step", header_sent_to: ["http://localhost:3000"] });
    expect(open.result).toBeUndefined();
  });
});

describe("a trace's MCP calls", () => {
  it("leave open exactly the calls no stamped request carried, and a step that sent one has no no-requests gap", () =>
    hegel.test((tc) => {
      const span = gs.text({ minSize: 16, maxSize: 16, alphabet: "0123456789abcdef" });
      const mcpSpans = [...new Set(tc.draw(gs.arrays(span, { minSize: 1, maxSize: 5 })))];
      const carried = mcpSpans.filter(() => tc.draw(gs.booleans()));
      const reading = createTraceTally({ spans: carried, spansNotKept: 0, processes: "none", processSpans: [], mcpSpans }).reading({ truncated: false, replaced: false });
      const unbounded = mcpSpans.length - carried.length;
      expect(reading.open.filter((gap) => gap.gap === "mcp-unbounded")).toEqual(unbounded === 0 ? [] : [{ gap: "mcp-unbounded", calls: unbounded }]);
      expect(reading.open.some((gap) => gap.gap === "no-requests")).toBe(false);
    }));
});

describe("measureMcp outside a step", () => {
  it("sends each message as it was given, and keeps the transport's own members", async () => {
    const sent: unknown[] = [];
    const heard: unknown[] = [];
    const transport = {
      pid: 41,
      async start() {},
      async send(message: unknown) {
        sent.push(message);
        transport.onmessage?.({ jsonrpc: "2.0", id: 1, result: {} });
      },
      async close() {},
      onmessage: undefined as ((message: unknown) => void) | undefined,
    };
    const measured = measureMcp(transport);
    measured.onmessage = (message) => heard.push(message);
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    await measured.send(message);
    expect(sent).toEqual([message]);
    expect(sent[0]).toBe(message);
    expect(heard).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(measured.pid).toBe(41);
  });
});
