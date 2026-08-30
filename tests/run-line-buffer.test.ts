import { describe, expect, it } from "vitest";
import { createLineBuffer } from "../src/run/line-buffer.js";

// Responsibility: src/run/run-concurrent.ts reads a worker's own stdout as
// chunks, never lines — a pipe has no notion of where one JSON envelope
// ends and the next begins, and getting this wrong is exactly what would
// let two workers' own output splice into one line that still parses as
// (wrong) JSON. This file pins that reassembly against the adversarial
// splits a real pipe can actually produce, independent of any worker
// process ever running.

describe("createLineBuffer", () => {
  it("emits nothing until a newline arrives", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push('{"kind":"note"');
    expect(lines).toEqual([]);
  });

  it("reassembles one line delivered across three chunks", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push('{"kind":"no');
    buffer.push('te","text":"hel');
    buffer.push('lo"}\n');
    expect(lines).toEqual(['{"kind":"note","text":"hello"}']);
  });

  it("splits two complete lines out of one chunk", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push('{"a":1}\n{"a":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("holds a trailing partial line for the next push, even after emitting a complete one in the same chunk", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push('{"a":1}\n{"a":2');
    expect(lines).toEqual(['{"a":1}']);
    buffer.push("}\n");
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("flush emits a held-back partial line exactly once, and is a no-op with nothing held back", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push('{"a":1}\n{"no-trailing-newline":true}');
    buffer.flush();
    expect(lines).toEqual(['{"a":1}', '{"no-trailing-newline":true}']);
    buffer.flush();
    expect(lines).toEqual(['{"a":1}', '{"no-trailing-newline":true}']);
  });

  it("accepts a Buffer the same way it accepts a string", () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push(Buffer.from('{"a":1}\n', "utf8"));
    expect(lines).toEqual(['{"a":1}']);
  });

  it("keeps a multi-byte character whole when a chunk boundary cuts through it", () => {
    // A pipe splits on bytes, and a scenario name written in Japanese is
    // three bytes per character. Decoding each chunk on its own turns the
    // split character into replacement characters, and the line still
    // parses as JSON, so the corruption reaches a record without ever
    // failing loudly.
    const source = '{"scenario":"\u691c\u7d22\u3059\u308b"}';
    const bytes = Buffer.from(`${source}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("\u691c", "utf8")) + 1;
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push(bytes.subarray(0, cut));
    buffer.push(bytes.subarray(cut));
    expect(lines).toEqual([source]);
  });

  it("never merges two workers' own lines into one, given the exact interleaving a real pipe can produce", () => {
    // The failure this whole module exists to prevent: worker A's own
    // write and worker B's own write land in the same underlying chunk,
    // A's own line unfinished when B's own bytes start.
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));
    buffer.push('{"worker":"a","partial":tr');
    buffer.push('ue}\n{"worker":"b","partial":false}\n');
    expect(lines).toEqual(['{"worker":"a","partial":true}', '{"worker":"b","partial":false}']);
  });
});
