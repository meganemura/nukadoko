import { describe, expect, it } from "vitest";
import { parseTraceActions } from "../src/context/trace-actions.js";

// Responsibility: the remaining "one malformed entry must not sink the rest
// of the parse" shapes tests/trace-actions.test.ts's own "skips one
// malformed JSON line without losing the rest" case doesn't cover: a
// syntactically valid JSON line that isn't a record with a string `type`
// at all, a `before`/`after` entry missing one of its own required fields,
// and a `context-options` entry present but missing one of the three
// fields a header needs. Every case here is a well-formed trace.trace whose
// own event *schema* is short a field, never a corrupt zip or a byte-level
// parse failure: an artificially broken zip would fix this file's own
// implementation shape rather than test its behavior, since a real
// Playwright trace never produces one.
//
// `parseTraceActions` takes a hand-built buffer directly (its own doc
// comment: "so a test can feed it a hand-built buffer without writing one
// to disk first"), the same technique trace-actions.test.ts's own describe
// block already uses.

const WALL_TIME = 1700000000000;
const MONOTONIC_TIME = 100;

function headerLine(version = 8): string {
  return JSON.stringify({
    version,
    type: "context-options",
    wallTime: WALL_TIME,
    monotonicTime: MONOTONIC_TIME,
    title: "Given the page is open",
  });
}

const VALID_BEFORE = {
  type: "before",
  callId: "call@valid",
  class: "Frame",
  method: "click",
  params: { selector: "#ok" },
  startTime: 10,
};
const VALID_AFTER = { type: "after", callId: "call@valid", endTime: 20 };

describe("parseTraceActions: one malformed entry among otherwise well-formed lines", () => {
  it('is unreadable when the only context-options line is missing a required field (never becomes "the" header)', () => {
    const traceTrace = [
      JSON.stringify({
        type: "context-options",
        version: 8,
        wallTime: WALL_TIME,
        // monotonicTime omitted on purpose: readHeader must reject this
        // entry rather than accept a header with an implicit "undefined"
        // monotonicTime.
      }),
      JSON.stringify(VALID_BEFORE),
      JSON.stringify(VALID_AFTER),
    ].join("\n");

    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));

    expect(result).toEqual({ kind: "unreadable" });
  });

  it("skips a before entry missing startTime, so its matching after is never counted, without losing a later valid pair", () => {
    const traceTrace = [
      headerLine(),
      JSON.stringify({
        type: "before",
        callId: "call@no-starttime",
        method: "click",
        params: {},
        // startTime omitted on purpose.
      }),
      JSON.stringify({ type: "after", callId: "call@no-starttime", endTime: 5 }),
      JSON.stringify(VALID_BEFORE),
      JSON.stringify(VALID_AFTER),
    ].join("\n");

    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.method).toBe("click");
  });

  it("skips an after entry missing endTime, without losing a later valid pair", () => {
    const traceTrace = [
      headerLine(),
      JSON.stringify(VALID_BEFORE),
      JSON.stringify({ type: "after", callId: "call@valid" /* endTime omitted on purpose */ }),
    ].join("\n");

    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    // The before/after pair above never completes an action (readAfter
    // rejects the missing endTime), and nothing else in this trace does
    // either.
    expect(result.actions).toHaveLength(0);
  });

  it("still records an action for a before entry with no params key at all, carrying none of the five allowed keys", () => {
    const traceTrace = [
      headerLine(),
      JSON.stringify({
        type: "before",
        callId: "call@no-params",
        method: "waitForLoadState",
        startTime: 0,
        // params omitted entirely, not merely empty.
      }),
      JSON.stringify({ type: "after", callId: "call@no-params", endTime: 3 }),
    ].join("\n");

    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0]!;
    expect(action.method).toBe("waitForLoadState");
    expect(action).not.toHaveProperty("expression");
    expect(action).not.toHaveProperty("selector");
    expect(action).not.toHaveProperty("url");
    expect(action).not.toHaveProperty("is_not");
    expect(action).not.toHaveProperty("timeout_ms");
  });

  it("skips a syntactically valid JSON line that is not a record with a string type, without losing a later valid pair", () => {
    const traceTrace = [
      headerLine(),
      "42",
      JSON.stringify(VALID_BEFORE),
      JSON.stringify(VALID_AFTER),
    ].join("\n");

    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.actions).toHaveLength(1);
  });
});
