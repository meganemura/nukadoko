import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { StringDecoder } from "node:string_decoder";
import { describe, expect, it } from "vitest";
import { captureStream, chunkBytes } from "../src/context/channels.js";
import { BODY_CAP, type RawBody, windowFor } from "../src/context/kept-text.js";

// Responsibility: the two pure parts of how a channel patch reads a body
// (src/context/channels.ts). `captureStream` reads a branch nukadoko owns
// only up to one chunk past the window, then cancels it, so a body of any
// length costs at most the window and a chunk. `chunkBytes` turns a string
// a stream decoded back into the bytes it came from, so redaction reads a
// body the same way whether or not the step called `setEncoding`.

const WINDOW = windowFor(BODY_CAP);

/** `raw` with its window as a plain Uint8Array, so a Buffer and the same
 * bytes compare equal. */
function plain(raw: RawBody): RawBody {
  return "window" in raw ? { ...raw, window: new Uint8Array(raw.window) } : raw;
}

describe("captureStream", () => {
  it("keeps the first window of bytes, pulls no chunk past the one that crosses it, and cancels the branch", () =>
    hegel.testAsync(async (tc) => {
      const sizes = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: WINDOW / 2 }), { maxSize: 12 }));
      const chunks = sizes.map((size, index) => new Uint8Array(size).fill(index % 251));
      let pulled = 0;
      let cancelled = false;
      // highWaterMark 0: the source is pulled only when the reader asks,
      // so `pulled` counts exactly the chunks captureStream asked for.
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulled === chunks.length) controller.close();
            else controller.enqueue(chunks[pulled++]!);
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const raw = plain(await captureStream(stream).done);
      const all = Buffer.concat(chunks);
      let crossing = 0;
      let sum = 0;
      while (crossing < chunks.length && sum <= WINDOW) sum += chunks[crossing++]!.length;
      if (all.length <= WINDOW) {
        expect(raw).toEqual({ window: new Uint8Array(all), total: all.length });
        expect(cancelled).toBe(false);
      } else {
        expect(raw).toEqual({ window: new Uint8Array(all.subarray(0, WINDOW)), read: sum, stopped: "cap" });
        expect(pulled).toBe(crossing);
        expect(cancelled).toBe(true);
      }
    }, { testCases: 60 }));

  it("stops with what arrived when the step ends before the body does", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const capture = captureStream(new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }));
    controller.enqueue(new TextEncoder().encode("data: one\n\n"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(plain(capture.finalize())).toEqual({ window: new TextEncoder().encode("data: one\n\n"), read: 11, stopped: "wait" });
    expect(plain(await capture.done)).toEqual({ window: new TextEncoder().encode("data: one\n\n"), read: 11, stopped: "wait" });
  });
});

describe("chunkBytes", () => {
  it("gives back the bytes a StringDecoder turned into strings, wherever the chunks split", () =>
    hegel.test((tc) => {
      const encoding = tc.draw(gs.sampledFrom(["base64", "hex", "latin1", "utf8", "utf16le", "base64url"] as const));
      // utf8 and utf16le decode only text to the same bytes; the others
      // decode any bytes.
      const bytes =
        encoding === "utf8" || encoding === "utf16le"
          ? Buffer.from(tc.draw(gs.text({ maxSize: 40 })), encoding)
          : Buffer.from(tc.draw(gs.binary({ maxSize: 60 })));
      const cuts = [...new Set(tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { maxSize: 4 })))].sort((a, b) => a - b);
      const decoder = new StringDecoder(encoding);
      const strings: string[] = [];
      let start = 0;
      for (const cut of [...cuts, bytes.length]) {
        strings.push(decoder.write(bytes.subarray(start, cut)));
        start = cut;
      }
      strings.push(decoder.end());
      const back = Buffer.concat(strings.map((text) => chunkBytes(text, encoding)!));
      expect(back.equals(bytes)).toBe(true);
    }));

  it("reads a string with no known encoding as UTF-8, and gives nothing for a callback", () => {
    expect(Buffer.from(chunkBytes("é", undefined)!).toString("hex")).toBe("c3a9");
    expect(Buffer.from(chunkBytes("é", "no-such-encoding")!).toString("hex")).toBe("c3a9");
    expect(chunkBytes(() => undefined, "utf8")).toBeUndefined();
  });
});
