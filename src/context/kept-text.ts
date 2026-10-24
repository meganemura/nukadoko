import type { KeptText } from "../record/types.js";
import { redactString, secretSpellings } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";

// Responsibility: turn the bytes of an HTTP body or a file into the
// `KeptText` a step record keeps (docs/spec.md "Records"): decoded as
// UTF-8, redacted, and cut at a cap. Pure; the callers decide which bytes
// to hand over and when.
//
// Redaction comes before the cut. Cutting first could keep the first
// characters of a secret that straddles the cap, and a partial secret is
// still a leak. So a caller hands over a window larger than the cap
// (`windowFor`), the whole window is redacted, and only then is the text
// cut to the cap. The window's own end can cut through a secret too, and
// a replacement shorter than the secret pulls that end toward the cap, so
// when the window is not the whole text, a trailing piece that starts any
// spelling of a secret is dropped before the cut. That can drop a few
// characters that only look like the start of a secret; the text is
// marked truncated either way. A body nukadoko stopped reading, at the
// cap or at the step's end, is never whole: a secret can go on past the
// last byte read.
//
// Bytes that are not UTF-8 text are not kept at all. Decoding them with
// replacement characters would produce text the program never sent, and
// a reader could not tell it from the real thing.

/** The cap for one HTTP request or response body, in bytes. */
export const BODY_CAP = 16 * 1024;
/** The cap for one file's content, in bytes. */
export const FILE_CAP = 8 * 1024;
/** The cap for all file content one step keeps, in bytes. */
export const STEP_FILES_CAP = 64 * 1024;

/** How many bytes a caller reads to keep `cap` bytes of text safely. */
export function windowFor(cap: number): number {
  return cap * 2;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The longest prefix of `bytes` that does not end inside a multi-byte
 * UTF-8 sequence. A window cut at an arbitrary byte can split the last
 * character, and that split is not a sign of binary data. */
export function wholeCharacters(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  // Walk back over at most three continuation bytes to the lead byte.
  let back = 0;
  while (back < 3 && end - back - 1 >= 0 && (bytes[end - back - 1]! & 0xc0) === 0x80) back += 1;
  const leadIndex = end - back - 1;
  if (leadIndex < 0) return bytes;
  const lead = bytes[leadIndex]!;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (length > back + 1) end = leadIndex;
  return bytes.subarray(0, end);
}

/** The longest prefix of `text` whose UTF-8 encoding fits in `cap` bytes. */
function cutToBytes(text: string, cap: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= cap) return text;
  return Buffer.from(wholeCharacters(encoded.subarray(0, cap))).toString("utf8");
}

/** `text` without the longest ending that is the start of a secret's
 * spelling, the part of a secret a cut left behind. */
function withoutSecretStart(text: string, secrets: SecretSet): string {
  let drop = 0;
  for (const spelling of secretSpellings(secrets)) {
    for (let length = Math.min(spelling.length - 1, text.length); length > drop; length -= 1) {
      if (text.endsWith(spelling.slice(0, length))) {
        drop = length;
        break;
      }
    }
  }
  return drop === 0 ? text : text.slice(0, text.length - drop);
}

/**
 * Keeps `window`, the first bytes of a body or a file, as text of at most
 * `cap` bytes. `whole` is false when bytes may follow the window (it was
 * cut, or the body had not ended), and then the text is marked truncated
 * whatever redaction did to its length. The caller adds the size.
 */
export function keepText(window: Uint8Array, whole: boolean, cap: number, secrets: SecretSet): { readonly text: string; readonly truncated?: true } | { readonly binary: true } {
  const decodable = whole ? window : wholeCharacters(window);
  let decoded: string;
  try {
    decoded = decoder.decode(decodable);
  } catch {
    return { binary: true };
  }
  const redacted = whole ? redactString(decoded, secrets) : withoutSecretStart(redactString(decoded, secrets), secrets);
  const text = cutToBytes(redacted, cap);
  const truncated = !whole || text.length < redacted.length;
  return { text, ...(truncated ? { truncated: true as const } : {}) };
}

/** A body as a channel read it: the first bytes (at most
 * `windowFor(BODY_CAP)`) and its whole size when that is known; or the
 * bytes read when nukadoko stopped before the end, at the cap (`"cap"`) or
 * when the step boundary stopped waiting (`"step_end"`); or the reason it
 * was not read at all. */
export type RawBody =
  | { readonly window: Uint8Array; readonly total: number }
  | { readonly window: Uint8Array; readonly read: number; readonly stopped: "cap" | "step_end" }
  | { readonly unread: string };

/** The record's form of one HTTP body. A body read to its end has `bytes`,
 * its whole size. One nukadoko stopped reading has `bytes_read` instead,
 * because its whole size was never seen and a reader must not take the
 * count for it. */
export function keepBody(raw: RawBody, secrets: SecretSet): KeptText {
  if ("unread" in raw) return { unread: raw.unread };
  if ("total" in raw) return { ...keepText(raw.window, raw.window.length >= raw.total, BODY_CAP, secrets), bytes: raw.total };
  return {
    ...keepText(raw.window, false, BODY_CAP, secrets),
    bytes_read: raw.read,
    ...(raw.stopped === "step_end" ? { incomplete: true as const } : {}),
  };
}

/** A request's or response's body fields for an http.jsonl line. A body
 * that ended after zero bytes is no body, and is left out like one, so a
 * HEAD or a 204 reads the same from every client. */
export function bodyFields(
  request: RawBody | undefined,
  response: RawBody | undefined,
  secrets: SecretSet,
): { readonly request_body?: KeptText; readonly response_body?: KeptText } {
  const kept = (raw: RawBody | undefined): KeptText | undefined =>
    raw === undefined || ("total" in raw && raw.total === 0) ? undefined : keepBody(raw, secrets);
  const requestBody = kept(request);
  const responseBody = kept(response);
  return {
    ...(requestBody !== undefined ? { request_body: requestBody } : {}),
    ...(responseBody !== undefined ? { response_body: responseBody } : {}),
  };
}

/** The `RawBody` of bytes already in hand. The window is a copy: the
 * caller's buffer can change after the request was sent. */
export function rawBodyOf(bytes: Uint8Array): RawBody {
  return { window: Uint8Array.from(bytes.subarray(0, windowFor(BODY_CAP))), total: bytes.byteLength };
}
