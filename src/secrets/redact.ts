import { toStoredForm } from "../stored-form/stored-form.js";
import { MIN_REDACTABLE_LENGTH, type SecretSet } from "./types.js";

// Responsibility: the one place a secret value actually becomes
// `{{secret.NAME}}` text (docs/spec.md "Environments and secrets"). Pure — no I/O, no
// knowledge of step records, http.jsonl, or stdout; callers (cli/do.ts,
// context/http-log.ts) decide *what* to redact and *when*, this module only
// knows *how*. Never reachable from a step's own `run`: redaction is
// applied "by the executor at write time" (docs/spec.md), and threading a
// SecretSet down to here happens only through executor-owned code paths.
//
// Redaction rules:
//   - a secret value found inside a string is replaced by `{{secret.NAME}}`.
//     An occurrence that is already part of such a token is left alone: the
//     token is the replacement, and searching it again rewrites the record;
//   - the same token also replaces other spellings of that loaded value.
//     A query string holds encodeURIComponent(value) by the time http.jsonl
//     is built. A URL's toJSON is the href, and that href percent-encodes
//     "'" as "%27" where encodeURIComponent leaves it, while a space stays
//     "%20". URLSearchParams serializes application/x-www-form-urlencoded:
//     a space is "+", and "!", "'", "(", ")", and "~" are percent-encoded.
//     Text that already contains JSON holds the interior of
//     JSON.stringify(value). All of these are the loaded value, so leaving
//     them is a leak of a secret nukadoko itself read. The JSON form is the
//     interior only: the quotes JSON.stringify adds are syntax, not part of
//     the value;
//   - values shorter than MIN_REDACTABLE_LENGTH are never redacted, in
//     any spelling (Honest limits: a short value would false-positive
//     constantly and destroy the step record it's supposed to protect).
//     Enforced here too, defensively, even though build-secret-set.ts
//     already excludes them. The floor is the loaded value's length, not
//     the length of a spelling: "a b" encodes to "a%20b" and still stays;
//   - a JSON number equal to a numeric secret is left as a number. The
//     loaded value is the decimal text, and that text is still removed
//     wherever it appears as a string. Matching the number would rewrite
//     counts and durations that happen to equal a loaded value, and it
//     would change the leaf's type;
//   - longer spellings are substituted first, so a shorter secret can't
//     eat part of a longer one that happens to contain it as a substring;
//   - every spelling is matched in one pass. The token written for one
//     secret is not searched for the next, and a token already in the text
//     is matched as itself. A loaded value that occurs inside
//     `{{secret.NAME}}` (the word "secret", or a piece of the name) therefore
//     cannot nest a second token there, and a second redact of the same
//     text changes nothing. Percent-encoded, form-urlencoded, and
//     JSON-escaped spellings are entries in that same list: one pass
//     replaces them and does not drop them;
//   - a raw loaded value claims its spelling before any other secret's
//     percent-encoded, form-urlencoded, or JSON-escaped form does. Among
//     raw values that are equal, and among derived forms that no raw value
//     claimed, the alphabetically-first key name wins, so which name a
//     step record shows is deterministic rather than dependent on
//     iteration order;
//   - the value is redacted in its stored form (src/stored-form): toJSON
//     applied and a bigint as its decimal string. Date and URL have no
//     enumerable properties, so walking them as objects would store {}
//     where the record holds the ISO string or the href, and a href can
//     carry a secret. A bigint's digits are redacted like any other string;
//   - object keys are redacted exactly like string values are, and if two
//     distinct keys end up identical after redaction, redact throws rather
//     than picking one and dropping the other's subtree (see redactInner);
//   - an entry marked `keep: "trace-ids"` is no secret (types.ts): the
//     world's trace ids, its prefix followed by 24 hexadecimal characters,
//     and the `traceparent` values that hold them are left as they are. A
//     secret's spelling that overlaps one still becomes the token for the
//     characters outside it, so no part of a secret is left beside the id.

interface Replacement {
  readonly value: string;
  readonly token: string;
}

/** What one redaction replaces, and the text it keeps whatever it holds. */
interface Plan {
  readonly replacements: readonly Replacement[];
  readonly keep: RegExp | undefined;
}

/** nukadoko's own trace ids for the worlds whose ids start with
 * `prefixes`, and the `traceparent` values that hold them
 * (src/context/trace-context.ts): a prefix, then 24 hexadecimal
 * characters, in either case, as a line's trace id is read. */
function traceIdPattern(prefixes: readonly string[]): RegExp | undefined {
  const hex = prefixes.filter((prefix) => /^[0-9a-f]{1,31}$/i.test(prefix));
  if (hex.length === 0) return undefined;
  return new RegExp(hex.map((prefix) => `(?:00-)?${prefix}[0-9a-f]{${32 - prefix.length}}(?:-[0-9a-f]{16}-[0-9a-f]{2})?`).join("|"), "gi");
}

function planFor(secrets: SecretSet): Plan {
  return {
    replacements: buildReplacements(secrets.filter((entry) => entry.keep === undefined)),
    keep: traceIdPattern(secrets.filter((entry) => entry.keep === "trace-ids").map((entry) => entry.value)),
  };
}

/** The spans of `input` that `keep` matches, as [start, end). */
function keptSpans(input: string, keep: RegExp): (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  for (const found of input.matchAll(keep)) spans.push([found.index, found.index + found[0].length]);
  return spans;
}

/** `match`, found at `offset`, with each run of characters outside every
 * kept span written as `token` and the characters inside left as they
 * are. */
function keepingSpans(match: string, offset: number, spans: readonly (readonly [number, number])[], token: string): string {
  let out = "";
  let outside = false;
  for (let index = 0; index < match.length; index += 1) {
    const at = offset + index;
    if (spans.some(([start, end]) => at >= start && at < end)) {
      out += match[index];
      outside = false;
    } else if (!outside) {
      out += token;
      outside = true;
    }
  }
  return out;
}

// Interior of a JSON string, without the quotes JSON.stringify adds.
// That is the spelling a secret already has when redact sees text that
// something else encoded as JSON first.
function jsonStringContents(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
}

// `slice(2)` drops the "k=" prefix. `toString` percent-encodes "&" and
// "=", so the value never contains a second parameter.
function formUrlEncoded(value: string): string {
  return new URLSearchParams([["k", value]]).toString().slice(2);
}

function claim(nameBySpelling: Map<string, string>, spelling: string, name: string): void {
  if (!nameBySpelling.has(spelling)) {
    nameBySpelling.set(spelling, name);
  }
}

function buildReplacements(secrets: SecretSet): Replacement[] {
  const redactable = [...secrets]
    .filter((entry) => entry.value.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const nameBySpelling = new Map<string, string>();
  // Raw values first, so a key that actually loaded this exact text wins
  // over another key whose percent-encoded or JSON-escaped form happens
  // to spell the same characters.
  for (const { name, value } of redactable) {
    claim(nameBySpelling, value, name);
  }
  for (const { name, value } of redactable) {
    claim(nameBySpelling, encodeURIComponent(value), name);
    // URL.toJSON percent-encodes "'" as "%27". encodeURIComponent leaves
    // that character as itself, so the href would still carry the secret.
    // A space in that href stays "%20", which is why this is not the
    // URLSearchParams spelling below.
    claim(nameBySpelling, encodeURIComponent(value).replaceAll("'", "%27"), name);
    claim(nameBySpelling, formUrlEncoded(value), name);
    claim(nameBySpelling, jsonStringContents(value), name);
  }

  return [...nameBySpelling.entries()]
    .map(([value, name]) => ({ value, token: `{{secret.${name}}}` }))
    .sort((a, b) => b.value.length - a.value.length);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function applyReplacements(input: string, { replacements, keep }: Plan): string {
  if (replacements.length === 0) return input;
  const tokenBySpelling = new Map(replacements.map((entry) => [entry.value, entry.token]));
  // Tokens go in the alternation beside the spellings. Sequential
  // split/join wrote `{{secret.NAME}}` and then searched that text for the
  // next value, so a secret that occurs inside the token rewrote it, and
  // the next call did it again. Matching the token as itself consumes the
  // span in the same pass. Longest first: the list is already ordered that
  // way, and a token can be longer or shorter than a spelling, so the
  // combined set is ordered here too. Equal lengths keep their relative
  // order (the alphabetically-first name was inserted first).
  const literals = new Set<string>([
    ...tokenBySpelling.keys(),
    ...replacements.map((entry) => entry.token),
  ]);
  const ordered = [...literals].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(ordered.map(escapeRegExp).join("|"), "g");
  const spans = keep === undefined ? [] : keptSpans(input, keep);
  if (spans.length === 0) return input.replace(pattern, (match) => tokenBySpelling.get(match) ?? match);
  // The alternation holds escaped literals only, so no capture group comes
  // between the match and its offset.
  return input.replace(pattern, (match: string, offset: number) => {
    const token = tokenBySpelling.get(match);
    return token === undefined ? match : keepingSpans(match, offset, spans, token);
  });
}

/** Every spelling `redactString` replaces for `secrets`: each loaded
 * value and its encoded forms. A caller that holds only the start of a
 * text needs them to find a secret the end of that start cut through. */
export function secretSpellings(secrets: SecretSet): string[] {
  return planFor(secrets).replacements.map((entry) => entry.value);
}

/** Replaces every occurrence of a secret value inside `input` with its
 * `{{secret.NAME}}` token, including the percent-encoded and JSON-escaped
 * spellings of that value. An occurrence already inside such a token is
 * left in place, so a second call returns the same text. */
export function redactString(input: string, secrets: SecretSet): string {
  return applyReplacements(input, planFor(secrets));
}

/** The stderr warning `nuka do` and `nuka run` share for a
 * fixture teardown that failed. The message is the fixture's own text, so it
 * is redacted here, once. No trailing newline: the caller frames the line. */
export function fixtureTeardownWarning(fixture: string, message: string, secrets: SecretSet): string {
  return `Warning: fixture "${fixture}" teardown failed: ${redactString(message, secrets)}`;
}

/** The same for a failed version probe, whose reason can quote a request
 * header the suite loaded. */
export function versionProbeWarning(environment: string, reason: string, secrets: SecretSet): string {
  return `Warning: version probe for environment "${environment}" failed: ${redactString(reason, secrets)}`;
}

function redactInner(value: unknown, plan: Plan): unknown {
  if (typeof value === "string") {
    return applyReplacements(value, plan);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, plan));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    // A key can carry a secret exactly as a value can (a suffix built from
    // request params, an id copied from a header), so it goes through the
    // same replacements. That reopens a risk a value-only walk never had:
    // two distinct original keys can redact to the identical string (e.g.
    // one key already spells out `{{secret.TOKEN}}` verbatim as ordinary
    // data, while a sibling key holds the raw secret value that token
    // stands for — after redaction both keys read `{{secret.TOKEN}}`).
    // Plain assignment would let the second key silently overwrite the
    // first, discarding a whole subtree with no trace it ever existed,
    // which is the one outcome "nothing breaks silently" rules out.
    // Throwing surfaces the collision immediately instead of shipping a
    // step record quietly missing data.
    const originalKeyOf = new Map<string, string>();
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const redactedKey = applyReplacements(key, plan);
      const priorKey = originalKeyOf.get(redactedKey);
      if (priorKey !== undefined) {
        throw new Error(
          `redact: keys ${JSON.stringify(priorKey)} and ${JSON.stringify(key)} both redact to ${JSON.stringify(redactedKey)}`,
        );
      }
      originalKeyOf.set(redactedKey, key);
      // defineProperty, not `result[key] =`: assigning to `__proto__`
      // sets the prototype, so a JSON body's own `__proto__` key would be
      // lost from the record while a claim compared it.
      Object.defineProperty(result, redactedKey, {
        value: redactInner(val, plan),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  // Numbers, booleans, null, undefined: nothing to redact, passed through
  // unchanged.
  return value;
}

/** Recursively redacts every string found anywhere inside the stored form
 * of `value` (src/stored-form), and returns that redacted stored form.
 * `value` itself is never mutated. */
export function redact(value: unknown, secrets: SecretSet): unknown {
  return redactInner(toStoredForm(value), planFor(secrets));
}
