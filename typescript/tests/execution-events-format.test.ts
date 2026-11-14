import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forEachLogLine } from "../src/context/program-log-slice.js";
import { ownerOf, parseEventLine, type ParsedLine } from "../src/execution-events/format.js";
import { op, PREFIX, render, SPANS, T, traceparent, U } from "./helpers/event-lines.js";

// Responsibility: src/execution-events/format.ts, the line format's one
// parser (docs/execution-events.md). Each state a line can be in, the
// reason an unreadable line gives, the owner a line has, and that a line
// is what parseEventLine says it is wherever the file was cut between
// reads.

describe("parseEventLine", () => {
  it("reads each kind the format defines, and a bare trace id, in either case", () => {
    const line = parseEventLine(JSON.stringify({ trace: traceparent(T, SPANS[0]!).toUpperCase(), kind: "request", id: "5a0f", method: "POST", route: null, status: 303 }));
    expect(line).toEqual({
      state: "event",
      trace: { traceId: T, span: SPANS[0] },
      kind: "request",
      object: { trace: traceparent(T, SPANS[0]!).toUpperCase(), kind: "request", id: "5a0f", method: "POST", route: null, status: 303 },
    });
    expect(parseEventLine(JSON.stringify({ trace: T, kind: "tx", id: "c7e2", phase: "rollback" }))).toMatchObject({ state: "event", trace: { traceId: T, span: null } });
    for (const object of [
      { kind: "db", table: "scores", op: "insert", rows: null, ids: ["a", 42], committed: true },
      { kind: "job", name: "ScoreRecalcJob", phase: "perform", job_id: "3f2a9c41" },
      { kind: "http", method: "GET", origin: "https://api.example", path: "/v1", status: null },
      { kind: "flag", name: "score_input_slider", side: "off", gate: "boolean" },
      { kind: "error", class: "ActiveRecord::RecordInvalid", handled: true },
      { kind: "db", table: "rooms", op: "read", x_cache: "hit", v: 1 },
    ]) {
      expect(parseEventLine(JSON.stringify({ trace: T, ...object })).state, JSON.stringify(object)).toBe("event");
    }
  });

  it("passes an optional field through as the line wrote it", () => {
    // A slice records what was read; which optional fields a count may
    // rely on is the reader's to check, not the parser's.
    const text = JSON.stringify({ trace: T, kind: "db", table: "a", op: "delete", rows: "3", ids: Array.from({ length: 101 }, (_, index) => index) });
    expect(parseEventLine(text)).toMatchObject({ state: "event", object: JSON.parse(text) });
  });

  it("keeps a writer's own kind, a kind it does not define, and a later version apart from an event", () => {
    expect(parseEventLine(JSON.stringify({ trace: T, kind: "x_cache", key: "k" }))).toMatchObject({ state: "extension", kind: "x_cache" });
    expect(parseEventLine(JSON.stringify({ trace: T, kind: "queue", depth: 3 }))).toMatchObject({ state: "undefined-kind", kind: "queue" });
    expect(parseEventLine(JSON.stringify({ trace: T, kind: "db", table: "t", op: "read", v: 2 }))).toMatchObject({ state: "unknown-version", kind: "db" });
  });

  it("names why a line is unreadable, and gives it no owner", () => {
    const cases: [string, string][] = [
      ['{"trace":"x","kind":"db",', "is not JSON"],
      ["[1,2]", "is not one JSON object"],
      [`{"trace":"${T}","kind":"db","table":"a","table":"b","op":"read"}`, 'holds the key "table" twice in one object'],
      [`{"trace":"${T}","kind":"db","table":"a","op":"insert","ids":[9007199254740993]}`, "holds an integer past 2^53 - 1; a writer writes a larger id as a string"],
      [JSON.stringify({ kind: "db", table: "a", op: "read" }), "has no trace that is a traceparent or a 32-character trace id"],
      [JSON.stringify({ trace: "0".repeat(32), kind: "db", table: "a", op: "read" }), "has no trace that is a traceparent or a 32-character trace id"],
      [JSON.stringify({ trace: `ff-${T}-${SPANS[0]}-01`, kind: "db", table: "a", op: "read" }), "has no trace that is a traceparent or a 32-character trace id"],
      [JSON.stringify({ trace: T, table: "a" }), "has no kind"],
      [JSON.stringify({ trace: T, kind: "db", op: "read" }), "is a db line with no table"],
      [JSON.stringify({ trace: T, kind: "db", table: "a", op: "write" }), 'is a db line whose op is "write", which is not one of read, insert, update, delete, other'],
      [JSON.stringify({ trace: T, kind: "tx", phase: "commit" }), "is a tx line with no id"],
      [JSON.stringify({ trace: T, kind: "request", method: "GET", route: "/", status: "200" }), "is a request line whose status is not an integer"],
    ];
    for (const [text, why] of cases) {
      const line = parseEventLine(text);
      expect(line, text).toEqual({ state: "unreadable", why });
      expect(ownerOf(line, PREFIX)).toBeNull();
    }
  });

  it("gives a line the step whose trace id its trace field holds, in the world of the prefix only", () => {
    const own = parseEventLine(JSON.stringify({ trace: traceparent(U, SPANS[0]!), kind: "db", table: "a", op: "read", x_note: traceparent(T, SPANS[1]!) }));
    expect(ownerOf(own, PREFIX)).toBe(U);
    expect(ownerOf(parseEventLine(JSON.stringify({ trace: "a1b2c3d477b34da6a3ce929d0e0e4736", kind: "x_probe" })), PREFIX)).toBeNull();
  });
});

/** Every line of `texts` parsed, as a reader that reads the file after
 * each of `cuts` sees them. */
function readInPieces(dir: string, texts: readonly string[], cuts: readonly number[]): ParsedLine[] {
  const file = path.join(dir, "events.jsonl");
  writeFileSync(file, "");
  const bytes = Buffer.from(texts.map((text) => `${text}\n`).join(""));
  const read: ParsedLine[] = [];
  let offset = 0;
  let at = 0;
  for (const cut of [...cuts, bytes.length]) {
    appendFileSync(file, bytes.subarray(at, cut));
    at = cut;
    offset = forEachLogLine(file, offset, (line) => read.push(parseEventLine(line)));
  }
  return read;
}

function withDir<Result>(run: (dir: string) => Result): Result {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-events-test-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("reading a file of events", () => {
  it("parses the same lines wherever the file was cut between reads, inside a character included", () =>
    hegel.test((tc) => {
      const texts = tc.draw(gs.arrays(gs.tuples(op, gs.sampledFrom(["", "\r", " x"])), { maxSize: 12 })).map(([entry, extra]) => render(entry, T, U, extra));
      const length = Buffer.byteLength(texts.map((text) => `${text}\n`).join(""));
      const cuts = [...tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: length }), { maxSize: 6 }))].sort((a, b) => a - b);
      const whole = texts.map((text) => parseEventLine(text));
      withDir((dir) => expect(readInPieces(dir, texts, cuts)).toEqual(whole));
    }));
});
