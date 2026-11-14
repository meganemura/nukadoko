import { StringDecoder } from "node:string_decoder";

// Responsibility: reassemble complete lines out of a child process's stdout
// chunks. A pipe delivers bytes, not lines: one `data` event can carry half
// a line, more than one line, or a line split across two events with no
// relation to where the writer's own `write()` calls began or ended. A
// worker's stdout carries one JSON object per line (src/run/worker-
// protocol.ts); parsing a chunk directly, instead of a reassembled line,
// risks feeding `JSON.parse` half an object that happens to still parse (a
// truncated object literal that closes early) or silently dropping a
// second object concatenated onto the first. Reassembling here, once, is
// what keeps every call site downstream trusting that what it receives is
// exactly one line, never more, never less.
//
// A pipe splits on bytes, so a chunk boundary can land inside a multi-byte
// UTF-8 character. `StringDecoder` holds the incomplete sequence back and
// finishes it with the next chunk's own leading bytes; `Buffer.toString`
// on each chunk alone would substitute replacement characters for both
// halves. That corruption is worse than a crash here, because the line
// still parses as JSON: a scenario name written in Japanese would reach a
// record mangled, having failed nowhere.

export interface LineBuffer {
  /** Feeds one chunk in; calls `onLine` once per complete line found so far,
   * newline stripped, in order. A trailing, newline-less fragment is held
   * back for the next `push` (or `flush`) rather than emitted early. */
  push(chunk: Buffer | string): void;
  /** Emits whatever partial line remains (e.g. the child exited without a
   * final newline) — a no-op when nothing is held back. Call once, when the
   * underlying stream ends. */
  flush(): void;
}

export function createLineBuffer(onLine: (line: string) => void): LineBuffer {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  return {
    push(chunk: Buffer | string): void {
      carry += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newlineIndex = carry.indexOf("\n");
      while (newlineIndex !== -1) {
        onLine(carry.slice(0, newlineIndex));
        carry = carry.slice(newlineIndex + 1);
        newlineIndex = carry.indexOf("\n");
      }
    },
    flush(): void {
      // `decoder.end()` yields whatever bytes of an unfinished character
      // are still held. They can only be an incomplete sequence at this
      // point, since the stream has ended, so this is where they become
      // visible rather than disappearing.
      carry += decoder.end();
      if (carry.length > 0) {
        onLine(carry);
        carry = "";
      }
    },
  };
}
