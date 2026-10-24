import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { bodyFields, keepBody, keepText, rawBodyOf, windowFor } from "../src/context/kept-text.js";
import { redactString } from "../src/secrets/redact.js";

// Responsibility: how a body or a file becomes the record's `KeptText`
// (src/context/kept-text.ts): redacted before it is cut, never more than
// the cap, marked truncated exactly when it is not the whole text, and a
// secret that the window's end or the cap cuts through leaves none of its
// characters behind. A body nukadoko stopped reading carries the bytes it
// read under `bytes_read`, never under `bytes`, and an ended body of zero
// bytes is left out of the line.

// The secret is digits and the filler never is, so "no digit in the kept
// text" is the exact statement that no character of the secret, whole or
// cut, reached the record. The token `{{secret.TOKEN}}` holds no digit.
const SECRET_ALPHABET = "0123456789";
const FILLER_ALPHABET = "ab \n{}\"é日";

const secretValue = gs.text({ alphabet: SECRET_ALPHABET, minSize: 4, maxSize: 40 });
const filler = gs.text({ alphabet: FILLER_ALPHABET, maxSize: 60 });

function textOf(kept: { readonly text?: string } | { readonly binary: true }): string {
  return "text" in kept ? (kept.text ?? "") : "";
}

describe("keepText", () => {
  it("keeps no character of a secret, wherever the cap and the window cut", () =>
    hegel.test((tc) => {
      const secret = tc.draw(secretValue);
      const parts = tc.draw(gs.arrays(filler, { minSize: 1, maxSize: 4 }));
      const text = parts.join(secret);
      const cap = tc.draw(gs.integers({ minValue: 1, maxValue: 120 }));
      const bytes = Buffer.from(text, "utf8");
      const window = bytes.subarray(0, windowFor(cap));
      const kept = keepText(window, window.length >= bytes.length, cap, [{ name: "TOKEN", value: secret }]);
      expect(textOf(kept)).not.toMatch(/[0-9]/);
    }));

  it("keeps at most the cap, and marks a cut exactly when the text is not whole", () =>
    hegel.test((tc) => {
      const secret = tc.draw(secretValue);
      const text = tc.draw(gs.arrays(filler, { minSize: 1, maxSize: 4 })).join(secret);
      const cap = tc.draw(gs.integers({ minValue: 1, maxValue: 120 }));
      const secrets = [{ name: "TOKEN", value: secret }];
      const bytes = Buffer.from(text, "utf8");
      const window = bytes.subarray(0, windowFor(cap));
      const kept = keepText(window, window.length >= bytes.length, cap, secrets);
      if (!("text" in kept)) throw new Error("UTF-8 text was kept as binary");
      expect(Buffer.byteLength(kept.text, "utf8")).toBeLessThanOrEqual(cap);
      const whole = redactString(text, secrets);
      expect(kept.truncated === true).toBe(kept.text !== whole);
      if (kept.truncated !== true) expect(kept.text).toBe(whole);
    }));

  it("keeps no text for bytes that are not UTF-8", () => {
    expect(keepText(Uint8Array.from([0x66, 0xff, 0x6f]), true, 16, [])).toEqual({ binary: true });
  });

  it("does not take a character the window cut in two for binary data", () => {
    const bytes = Buffer.from("aé", "utf8");
    expect(keepText(bytes.subarray(0, 2), false, 16, [])).toEqual({ text: "a", truncated: true });
  });
});

describe("keepBody", () => {
  it("never keeps a secret, counts a whole body under bytes and a stopped one under bytes_read", () =>
    hegel.test((tc) => {
      const secret = tc.draw(secretValue);
      const text = tc.draw(gs.arrays(filler, { minSize: 1, maxSize: 4 })).join(secret);
      const stopped = tc.draw(gs.sampledFrom([undefined, "cap", "step_end"] as const));
      const bytes = Buffer.from(text, "utf8");
      const raw = rawBodyOf(bytes);
      if (!("total" in raw)) throw new Error("bytes in hand were not read whole");
      const kept = keepBody(stopped === undefined ? raw : { window: raw.window, read: bytes.length, stopped }, [{ name: "TOKEN", value: secret }]);
      expect(kept.text ?? "").not.toMatch(/[0-9]/);
      expect(kept.incomplete === true).toBe(stopped === "step_end");
      if (stopped === undefined) {
        expect(kept.bytes).toBe(bytes.length);
        expect(kept.bytes_read).toBeUndefined();
      } else {
        // A stopped body's size was never seen, so no field may read as it.
        expect(kept.bytes).toBeUndefined();
        expect(kept.bytes_read).toBe(bytes.length);
        if (!("binary" in kept)) expect(kept.truncated).toBe(true);
      }
    }));

  it("keeps the reason for a body it did not read", () => {
    expect(keepBody({ unread: "a multipart body, encoded by Playwright" }, [])).toEqual({ unread: "a multipart body, encoded by Playwright" });
  });
});

describe("bodyFields", () => {
  it("leaves out a body that ended after zero bytes, and keeps every other", () => {
    const empty = rawBodyOf(new Uint8Array());
    expect(bodyFields(empty, empty, [])).toEqual({});
    expect(bodyFields(undefined, undefined, [])).toEqual({});
    expect(bodyFields(undefined, rawBodyOf(Buffer.from("ok")), [])).toEqual({ response_body: { text: "ok", bytes: 2 } });
    // Zero bytes read before the step ended is not a body known to be empty.
    expect(bodyFields(undefined, { window: new Uint8Array(), read: 0, stopped: "step_end" }, [])).toEqual({
      response_body: { text: "", truncated: true, bytes_read: 0, incomplete: true },
    });
  });
});
