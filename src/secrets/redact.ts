import { toStoredForm } from "../stored-form/stored-form.js";
import { MIN_REDACTABLE_LENGTH, type SecretSet } from "./types.js";

// Responsibility: the one place a secret value actually becomes
// `{{secret.NAME}}` text (docs/spec.md "Secrets"). Pure — no I/O, no
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
//     "'" as "%27" where encodeURIComponent leaves it. Text that already
//     contains JSON holds the interior of JSON.stringify(value). All of
//     these are the loaded value, so leaving them is a leak of a secret
//     nukadoko itself read. The JSON form is the interior only: the quotes
//     JSON.stringify adds are syntax, not part of the value;
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
//     text changes nothing. Percent-encoded and JSON-escaped spellings are
//     entries in that same list: one pass replaces them and does not drop
//     them;
//   - a raw loaded value claims its spelling before any other secret's
//     percent-encoded or JSON-escaped form does. Among raw values that
//     are equal, and among derived forms that no raw value claimed, the
//     alphabetically-first key name wins, so which name a step record
//     shows is deterministic rather than dependent on iteration order;
//   - the value is redacted in its stored form (src/stored-form): toJSON
//     applied and a bigint as its decimal string. Date and URL have no
//     enumerable properties, so walking them as objects would store {}
//     where the record holds the ISO string or the href, and a href can
//     carry a secret. A bigint's digits are redacted like any other string;
//   - object keys are redacted exactly like string values are, and if two
//     distinct keys end up identical after redaction, redact throws rather
//     than picking one and dropping the other's subtree (see redactInner).

interface Replacement {
  readonly value: string;
  readonly token: string;
}

// Interior of a JSON string, without the quotes JSON.stringify adds.
// That is the spelling a secret already has when redact sees text that
// something else encoded as JSON first.
function jsonStringContents(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
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
    claim(nameBySpelling, encodeURIComponent(value).replaceAll("'", "%27"), name);
    claim(nameBySpelling, jsonStringContents(value), name);
  }

  return [...nameBySpelling.entries()]
    .map(([value, name]) => ({ value, token: `{{secret.${name}}}` }))
    .sort((a, b) => b.value.length - a.value.length);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function applyReplacements(input: string, replacements: readonly Replacement[]): string {
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
  return input.replace(pattern, (match) => tokenBySpelling.get(match) ?? match);
}

/** Replaces every occurrence of a secret value inside `input` with its
 * `{{secret.NAME}}` token, including the percent-encoded and JSON-escaped
 * spellings of that value. An occurrence already inside such a token is
 * left in place, so a second call returns the same text. */
export function redactString(input: string, secrets: SecretSet): string {
  return applyReplacements(input, buildReplacements(secrets));
}

/** The stderr warning `nuka do`, `nuka run`, and a live session share for a
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

function redactInner(value: unknown, replacements: readonly Replacement[]): unknown {
  if (typeof value === "string") {
    return applyReplacements(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, replacements));
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
      const redactedKey = applyReplacements(key, replacements);
      const priorKey = originalKeyOf.get(redactedKey);
      if (priorKey !== undefined) {
        throw new Error(
          `redact: keys ${JSON.stringify(priorKey)} and ${JSON.stringify(key)} both redact to ${JSON.stringify(redactedKey)}`,
        );
      }
      originalKeyOf.set(redactedKey, key);
      result[redactedKey] = redactInner(val, replacements);
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
  return redactInner(toStoredForm(value), buildReplacements(secrets));
}
