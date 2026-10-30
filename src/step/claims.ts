import { selectionSentenceValues } from "../execution-events/selection.js";
import type { ClaimCompare, ClaimView } from "../record/types.js";

// Responsibility: what a claim step declares in place of `run`
// (docs/spec.md "Claims"), and the rules a declaration must pass before
// `defineStep` stores it. A Then step does not judge in code: it names the
// value it reads (`actual`), where the value it compares with comes from
// (`expected`), and how the two compare, and nukadoko does the judging, so
// the expected value is in the sentence or in an earlier step's result,
// never in step code. This module holds the declaration types, the path
// syntax both sides share, the literal rule, and what a claim on a count
// of execution events may declare. It does not evaluate a
// claim (src/step/evaluate-claims.ts does) and does not read a feature file
// (`nuka check` resolves a claim against the line that binds it).

/** Every compare a claim may name. */
export const CLAIM_COMPARES = [
  "equal",
  "not-equal",
  "contains-text",
  "starts-with-text",
  "ends-with-text",
  "has-item",
  "has-same-items",
  "has-fields",
  "lacks-field",
  "fits-text",
  "fits-aria-snapshot",
  "is-a",
  "matches",
  "greater-than",
  "at-least",
  "less-than",
  "at-most",
] as const satisfies readonly ClaimCompare[];

/** Every view a claim may name. */
export const CLAIM_VIEWS = ["text", "lines", "json", "comma-list"] as const satisfies readonly ClaimView[];

/** Every kind `is-a` may name. A sentence can name the kind of a generated
 * value (an id, a time, a link) when it cannot state the value itself;
 * src/step/evaluate-claims.ts holds what a value of each kind is. */
export const VALUE_KINDS = ["string", "text", "number", "integer", "boolean", "list", "array", "object", "null", "uuid", "date", "timestamp", "url"] as const;

export type ValueKind = (typeof VALUE_KINDS)[number];

/** The kind `name` names, read after trimming and ignoring case, or
 * `undefined` for a name that is no kind. Pure. */
export function kindNamed(name: string): ValueKind | undefined {
  const key = name.trim().toLowerCase();
  return (VALUE_KINDS as readonly string[]).includes(key) ? (key as ValueKind) : undefined;
}

// Fails to compile when the record's union gains a member this list lacks.
type MissingCompare = Exclude<ClaimCompare, (typeof CLAIM_COMPARES)[number]>;
type MissingView = Exclude<ClaimView, (typeof CLAIM_VIEWS)[number]>;
const COMPARES_COMPLETE: MissingCompare extends never ? true : never = true;
const VIEWS_COMPLETE: MissingView extends never ? true : never = true;
void COMPARES_COMPLETE;
void VIEWS_COMPLETE;

/** A value a literal may hold: one with a text a sentence can state. */
export type ClaimLiteral = string | number | boolean | null | readonly [];

/** Where a claim's expected value comes from. A string is an args key the
 * sentence fills (a capture, the docstring, or the table). `from` is a path
 * whose first segment is a key `from` fills from an earlier step. `literal`
 * is a value the pattern's own fixed words state. `observe` is a path into
 * a second reading `observe` returns. */
export type ClaimExpected =
  | string
  | { readonly from: string }
  | { readonly literal: ClaimLiteral }
  | { readonly observe: string };

/** A comparison between one measured value and one expected value. The
 * first segment of `actual` is a `from` key, or else a key of what
 * `observe` returns. */
export interface ComparisonClaim {
  readonly actual: string;
  readonly view?: ClaimView;
  readonly at?: string;
  /** Compares the number of items of the array that `view` and `at`
   * leave, so "the list shows 3 orders" is judged on the list itself and
   * not on a length step code worked out. */
  readonly count?: true;
  readonly compare: ClaimCompare;
  readonly expected: ClaimExpected;
  /** For an expected value the sentence fills: how nukadoko reads the text
   * the line states (`json` parses a docstring), so no args schema has to
   * rewrite the value before the claim compares it. */
  readonly expected_view?: ClaimView;
  readonly each?: never;
}

/** A comparison on one item of an `each`: `actual` is a path relative to
 * the item, or absent for the item itself. */
export interface ItemClaim {
  readonly actual?: string;
  readonly view?: ClaimView;
  readonly at?: string;
  readonly count?: true;
  readonly compare: ClaimCompare;
  readonly expected: ClaimExpected;
  readonly expected_view?: ClaimView;
}

/** Claims over every item of an array, or over each item every `where`
 * claim holds for. */
export interface EachClaim {
  readonly actual: string;
  readonly view?: ClaimView;
  readonly at?: string;
  readonly each: {
    readonly where?: readonly ItemClaim[];
    readonly claims: readonly ItemClaim[];
  };
  readonly count?: never;
  readonly compare?: never;
  readonly expected?: never;
  readonly expected_view?: never;
}

export type Claim = ComparisonClaim | EachClaim;

/** `poll: { timeout_ms }` re-reads until every claim holds on two
 * consecutive readings; `false` reads once. */
export type ClaimPoll = false | { readonly timeout_ms: number };

export function isEachClaim(claim: Claim): claim is EachClaim {
  return claim.each !== undefined;
}

/** A path's segments: dot-separated, each one an object key or an array
 * index. `null` for a path with an empty segment. */
export function pathSegments(path: string): readonly string[] | null {
  const segments = path.split(".");
  return segments.every((segment) => segment.length > 0) ? segments : null;
}

// --- where a value is ---
//
// Two sides of a claim read the same value when they start at the same
// origin and walk the same path, a view counted as a step of the path. The
// check and the run name origins differently (a feature line, a step
// record), so each builds its own places, and both compare them here, with
// one index syntax: an array index is a path segment like any key.

/** Where one side of a claim reads its value: the `origin` it starts at
 * (`observe`, a producing step's line or record, a sentence key), the
 * path inside it, and the label the record names it by. `open` is true
 * when the label ends in a view, so the next segment reads ` at <path>`. */
export interface ClaimPlace {
  readonly origin: string;
  readonly segments: readonly string[];
  readonly label: string;
  readonly open: boolean;
}

/** A segment the check uses for every index of an `each`: the run knows
 * the index, and the check knows only that some index is read. */
export const ANY_INDEX = "*";

const INDEX_SEGMENT = /^(0|[1-9][0-9]*)$/;

/** `place` with `path` walked further. Pure. */
export function placeAt(place: ClaimPlace, path: string | undefined): ClaimPlace {
  if (path === undefined || path === "") return place;
  const separator = place.open ? " at " : place.label.endsWith(":") ? "" : ".";
  return { origin: place.origin, segments: [...place.segments, ...path.split(".")], label: `${place.label}${separator}${path}`, open: false };
}

/** `place` read through `view`. Pure. */
export function placeViewed(place: ClaimPlace, view: ClaimView | undefined): ClaimPlace {
  if (view === undefined) return place;
  return { origin: place.origin, segments: [...place.segments, `#${view}`], label: `${place.label} as ${view}`, open: true };
}

/** `place` counted, when `count` is true: a count is the last step a claim
 * takes, so the label names it first and no path walks on from it. Pure. */
export function placeCounted(place: ClaimPlace, count: boolean | undefined): ClaimPlace {
  if (count !== true) return place;
  return { origin: place.origin, segments: [...place.segments, "#count"], label: `count of ${place.label}`, open: false };
}

/** The compare whose actual value is the ARIA snapshot nukadoko takes of
 * the locator or page at its path, and not the value there. */
export const ARIA_SNAPSHOT_COMPARE = "fits-aria-snapshot" satisfies ClaimCompare;

/** `place` read through the ARIA snapshot nukadoko takes of the locator or
 * page there: like a count, the last step a claim takes, so the label
 * names it first. Pure. */
export function placeAriaSnapshot(place: ClaimPlace): ClaimPlace {
  return { origin: place.origin, segments: [...place.segments, "#aria-snapshot"], label: `ARIA snapshot of ${place.label}`, open: false };
}

function sameSegment(a: string, b: string): boolean {
  return a === b || (a === ANY_INDEX && INDEX_SEGMENT.test(b)) || (b === ANY_INDEX && INDEX_SEGMENT.test(a));
}

/** Whether two places read the same value. Pure. */
export function samePlace(a: Pick<ClaimPlace, "origin" | "segments">, b: Pick<ClaimPlace, "origin" | "segments">): boolean {
  return a.origin === b.origin && a.segments.length === b.segments.length && a.segments.every((segment, index) => sameSegment(segment, b.segments[index]!));
}

/** Why a claim does not judge an expected args key that `pattern` fills
 * with `type`, a parameter type with a transformer: the transformer
 * rewrites the line's text before the claim reads it. The run's half of
 * `claim-expected-transformed`, in the check's words. Pure. */
export function transformedFillReason(pattern: string, key: string, type: string): string {
  return (
    `the pattern "${pattern}" fills args.${key} with the parameter type {${type}}, whose transformer rewrites the line's text before the claim reads it, ` +
    "so code would decide what the claim compares, and the claim was not judged"
  );
}

/** Whether one place holds the other: the same origin, and one path is the
 * start of the other. Pure. */
export function placesOverlap(a: Pick<ClaimPlace, "origin" | "segments">, b: Pick<ClaimPlace, "origin" | "segments">): boolean {
  if (a.origin !== b.origin) return false;
  const length = Math.min(a.segments.length, b.segments.length);
  for (let index = 0; index < length; index += 1) {
    if (!sameSegment(a.segments[index]!, b.segments[index]!)) return false;
  }
  return true;
}

// Thrown inside this module only: the first problem found ends the check,
// and the exported functions return its message.
class InvalidClaimError extends Error {}

// --- the literal rule ---
//
// A literal is the one expected value that is in neither the sentence's
// data nor an earlier step's result, so it would let step code carry the
// criterion again ("the command succeeds" claiming 0). It is allowed only
// when the sentence itself states it: its text is exactly a run of the
// pattern's fixed words, joined by one space, a whole number from zero to
// twelve that a fixed word spells (or `once` and `twice`, which state 1
// and 2), or it is the fixed value of a fixed word in the table below. A word inside a capture, an optional
// group, or an alternation is not fixed, because the sentence a line binds
// may not say it. Only the pattern side is normalized (edge punctuation
// taken off its words): a literal with other spacing or punctuation is a
// text the sentence does not state.
//
// A value from the table is compared with `equal` alone. "no item is
// unpaid" read as `at-least 0`, or "the cart is empty" read as
// `not-equal []`, would hold for nearly anything, and the word gives
// the reader no way to see that. The one exception is the fixed word
// `not` right before the table word: "the list is not empty" says
// `not-equal []`, and then `not-equal` is the only compare, since
// `equal []` would claim the opposite of the line. `neither` and `nor`
// right before a table word negate it the same way ("neither empty nor
// blank"), and `neither` states an empty value itself only when no `nor`
// follows it: "neither blank nor whitespace" denies two things and states
// none.

/** The fixed words that negate the table word right after them. */
const NEGATING_WORDS: ReadonlySet<string> = new Set(["not", "neither", "nor"]);

/** The values a word fixes, compared case-insensitively. */
export const LITERAL_WORDS: Readonly<Record<string, readonly ClaimLiteral[]>> = {
  no: [0, "", []],
  none: [0, "", []],
  nothing: [0, "", []],
  neither: [0, "", []],
  never: [0],
  empty: ["", []],
};

/** The values `word` fixes through the table, compared
 * case-insensitively, or none. An own-key lookup: a plain object also
 * answers `constructor` and `toString`, and a pattern may hold either
 * word. Pure. */
export function tableValuesOf(word: string): readonly ClaimLiteral[] {
  const lower = word.toLowerCase();
  return Object.hasOwn(LITERAL_WORDS, lower) ? LITERAL_WORDS[lower]! : [];
}

/** The words that write a whole number in a sentence, by value: a fixed
 * word here states its number as the digits would ("at least three
 * routed points" states 3), under any compare. Twelve is where English
 * prose usually turns to digits. */
export const NUMBER_WORDS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** The words that state how many times something happened, by value: "the
 * row was inserted once" states 1, under any compare, as a number word
 * does. */
export const TIMES_WORDS: Readonly<Record<string, number>> = { once: 1, twice: 2 };

/** The whole number a fixed word states as its digits would, a number word
 * or a times word, compared case-insensitively, or `null`. Pure. */
export function numberOfWord(word: string): number | null {
  const lower = word.toLowerCase();
  const spelled = NUMBER_WORDS.indexOf(lower);
  if (spelled !== -1) return spelled;
  return Object.hasOwn(TIMES_WORDS, lower) ? TIMES_WORDS[lower]! : null;
}

const EDGE_PUNCTUATION = /^[.,;:!?"'`]+|[.,;:!?"'`]+$/g;

function normalizedWord(word: string): string {
  return word.replace(EDGE_PUNCTUATION, "");
}

/** One word of a pattern: its text with edge punctuation removed, and
 * whether a matching sentence always contains it. */
interface PatternWord {
  readonly text: string;
  readonly fixed: boolean;
}

/** The words of `pattern` a matching sentence always contains, in order,
 * with edge punctuation removed. A word that holds a capture, an optional
 * group, or an alternation is left out. Pure. */
export function fixedWords(pattern: string): readonly string[] {
  return patternWords(pattern)
    .filter((word) => word.fixed)
    .map((word) => word.text);
}

/** Every word of `pattern` in order, a word that is not fixed included
 * (its text may be empty: a capture alone), so a caller can tell two fixed
 * words that sit side by side from two with a capture between them. */
function patternWords(pattern: string): readonly PatternWord[] {
  const words: PatternWord[] = [];
  let word = "";
  let fixed = true;
  const end = (): void => {
    const normalized = normalizedWord(word);
    if (!fixed || normalized.length > 0) words.push({ text: normalized, fixed });
    word = "";
    fixed = true;
  };
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      word += pattern[i + 1]!;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      end();
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "(") {
      const close = ch === "{" ? "}" : ")";
      fixed = false;
      i += 1;
      while (i < pattern.length && pattern[i] !== close) {
        i += pattern[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (ch === "/") {
      fixed = false;
    }
    word += ch;
    i += 1;
  }
  end();
  return words;
}

/** The text a literal is in a sentence, or `null` for a value no text
 * states (`[]`, a number that is not finite, anything else). */
function literalText(literal: unknown): string | null {
  if (typeof literal === "string") return literal;
  if (typeof literal === "number" && Number.isFinite(literal)) return String(literal);
  if (typeof literal === "boolean" || literal === null) return String(literal);
  return null;
}

function isLiteralValue(literal: unknown): boolean {
  return literalText(literal) !== null || (Array.isArray(literal) && literal.length === 0);
}

function sameLiteral(a: unknown, b: ClaimLiteral): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === 0 && b.length === 0;
  return Object.is(a, b);
}

function isRunOf(words: readonly string[], text: string): boolean {
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= words.length; end += 1) {
      if (words.slice(start, end).join(" ") === text) return true;
    }
  }
  return false;
}

/** How a pattern states a literal: `words` as the record names them
 * (`literal:<words>`), `byTable` when a word of the table fixes the
 * value rather than the literal's own text being the words, and, for a
 * value the table fixes, the one compare it takes: `not-equal` when the
 * fixed word right before the table word is `not`, `equal` otherwise.
 * `compare` is `null` for a literal the pattern's own words are. */
export interface LiteralStatement {
  readonly words: string;
  readonly byTable: boolean;
  readonly compare: "equal" | "not-equal" | null;
  /** The fixed word that negates a table word, as the pattern writes it. */
  readonly negatedBy?: string;
}

/** How `pattern` states `literal`, or `null` when it does not. Pure. */
export function literalStatement(pattern: string, literal: unknown): LiteralStatement | null {
  const all = patternWords(pattern);
  const words = all.filter((word) => word.fixed).map((word) => word.text);
  const text = literalText(literal);
  if (text !== null && text.length > 0 && isRunOf(words, text)) return { words: text, byTable: false, compare: null };
  const spelled = typeof literal === "number" ? words.find((word) => numberOfWord(word) === literal) : undefined;
  if (spelled !== undefined) return { words: spelled, byTable: false, compare: null };
  for (const [index, word] of all.entries()) {
    if (!word.fixed) continue;
    const lower = word.text.toLowerCase();
    if (!tableValuesOf(lower).some((value) => sameLiteral(literal, value))) continue;
    if (lower === "neither" && all.slice(index + 1).some((later) => later.fixed && later.text.toLowerCase() === "nor")) continue;
    const before = index > 0 ? all[index - 1]! : null;
    const negated = before !== null && before.fixed && NEGATING_WORDS.has(before.text.toLowerCase());
    return negated ? { words: word.text, byTable: true, compare: "not-equal", negatedBy: before.text } : { words: word.text, byTable: true, compare: "equal" };
  }
  return null;
}

/** The pattern words that state `literal`, or `null`. Pure. */
export function literalStatedBy(pattern: string, literal: unknown): string | null {
  return literalStatement(pattern, literal)?.words ?? null;
}

/** How every pattern states `literal`, or `null` when one pattern does
 * not: a line may bind any of them. The first pattern's words name it, and
 * `byTable` is true when any pattern states it only through the table. */
export function literalStatementOfAll(patterns: readonly string[], literal: unknown): LiteralStatement | null {
  if (patterns.length === 0) return null;
  const stated = patterns.map((pattern) => literalStatement(pattern, literal));
  if (!stated.every((statement) => statement !== null)) return null;
  return { words: stated[0]!.words, byTable: stated.some((statement) => statement!.byTable), compare: stated[0]!.compare };
}

/** The words that state `literal` in every pattern, or `null`. Pure. */
export function literalStatedByAll(patterns: readonly string[], literal: unknown): string | null {
  return literalStatementOfAll(patterns, literal)?.words ?? null;
}

// --- declaration validation ---

/** What `validateClaims` needs to know about the step besides its claims. */
export interface ClaimStepShape {
  readonly patterns: readonly string[];
  /** The args keys a z.object schema declares, or `null` when args is not
   * one, so nothing can be said about which keys exist. */
  readonly argsKeys: ReadonlySet<string> | null;
  /** The args keys a value must be given for: no default, not optional.
   * `null` when args is not a z.object. */
  readonly requiredArgsKeys: ReadonlySet<string> | null;
  readonly fromKeys: ReadonlySet<string>;
  /** The keys any pattern captures. A capture wins over `from` for the
   * same key, so a line would fill such a key itself. */
  readonly captureKeys: ReadonlySet<string>;
  readonly hasObserve: boolean;
  /** The args keys whose schema rewrites the value it parses, with what
   * rewrites it (`schemaRewrite` in binding/schema-shape.ts). */
  readonly rewrittenArgs: ReadonlyMap<string, string>;
  /** What on the args schema itself rewrites every value it parses
   * (`argsSchemaRewrite`), such as a refine on the args object; absent
   * when nothing does. */
  readonly argsRewrite?: string | null;
  /** The args keys whose schema is a plain `z.string()`, which
   * `expected_view` can read; `null` when args is not a z.object. */
  readonly stringArgs: ReadonlySet<string> | null;
  /** What the step's `events` declares (`eventsShapeOf`); absent for a
   * step with none. */
  readonly events?: EventsShape;
}

// --- execution events ---
//
// A claim step's `events` names counts of an earlier step's execution
// events (docs/spec.md "Execution events"), and a claim reads one by its
// key alone, as its actual. nukadoko measures the count, so the claim
// takes no path, view, at, or count (the count is already one number),
// and neither observe nor an args value can stand in for it: an events
// key shares no name with a from key or an args key. A count nothing
// compares changes no verdict, so every key must be read. A selection
// may take a value from the sentence (`{ sentence: "table" }`), which is
// then a value the line states, under the rules an expected sentence key
// follows.

/** One value a selection takes from the sentence: the events key, the
 * field, and the args key that holds the value. */
export interface EventsSentenceValue {
  readonly key: string;
  readonly field: string;
  readonly name: string;
}

/** What a claim step's `events` adds to what its claims read: the keys a
 * claim's actual names whole, and the values its selections take from
 * the sentence. */
export interface EventsShape {
  readonly keys: ReadonlySet<string>;
  readonly sentenceValues: readonly EventsSentenceValue[];
}

/** The shape of a step with no `events`. */
export const NO_EVENTS: EventsShape = { keys: new Set(), sentenceValues: [] };

/** The shape of an `events` declaration, read as far as it is an object
 * of entries with a `count`: what `validateClaims` needs beside it.
 * Pure. */
export function eventsShapeOf(events: unknown): EventsShape {
  if (typeof events !== "object" || events === null || Array.isArray(events)) return NO_EVENTS;
  const keys = new Set<string>();
  const sentenceValues: EventsSentenceValue[] = [];
  for (const [key, entry] of Object.entries(events)) {
    keys.add(key);
    const count = typeof entry === "object" && entry !== null ? (entry as { count?: unknown }).count : undefined;
    for (const value of selectionSentenceValues(count)) sentenceValues.push({ key, ...value });
  }
  return { keys, sentenceValues };
}

/** The args keys a step's selections take a value from. Pure. */
export function eventsSentenceKeys(events: EventsShape): ReadonlySet<string> {
  return new Set(events.sentenceValues.map((value) => value.name));
}

/** The keys a claim on a count of execution events has. */
const EVENTS_CLAIM_KEYS = ["actual", "compare", "expected"] as const;

/** Refuses a claim on events key `key` that the run would judge one way
 * on every line, or whose actual is not the count alone. */
function checkEventsClaim(label: string, claim: Record<string, unknown>, key: string, shape: ClaimStepShape): void {
  const reads = `${label} reads events.${key}, a count of execution events`;
  if (claim.each !== undefined) {
    throw new InvalidClaimError(`${reads}, which is one number, and each reads the items of an array. Compare the count with ${COUNT_COMPARES.join(", ")}`);
  }
  checkKeys(label, claim, EVENTS_CLAIM_KEYS, "a claim on a count of execution events");
  if (!(COUNT_COMPARES as readonly unknown[]).includes(claim.compare)) {
    throw new InvalidClaimError(
      `${reads}, which is a number, and ${describe(claim.compare)} does not compare two numbers, so the claim would break on every line or hold on every line. Compare the count with ${COUNT_COMPARES.join(", ")}`,
    );
  }
  checkExpected(label, claim.expected, claim.compare, shape, false);
  const literal = literalOf(claim.expected);
  if (literal !== null && typeof literal.literal !== "number") {
    throw new InvalidClaimError(
      `${reads}, which is a number, and its expected value is the literal ${describe(literal.literal)}, which is never a number, so the claim always breaks. State the number in the pattern, as digits, a number word, once, twice, or a word such as nothing or never, and write it as a number literal`,
    );
  }
  if (typeof claim.expected === "string" && shape.stringArgs?.has(claim.expected) === true) {
    throw new InvalidClaimError(
      `${reads}, which is a number, and its expected value is args.${claim.expected}, a plain z.string(), which is never a number, so the claim always breaks. Capture the number with {int}`,
    );
  }
}

/** Refuses an `events` declaration that collides with another source of
 * a claim's actual, takes a sentence value an expected sentence key could
 * not be, or names a count no claim reads. */
function checkEvents(claims: readonly Record<string, unknown>[], shape: ClaimStepShape): void {
  const events = shape.events ?? NO_EVENTS;
  for (const key of events.keys) {
    const other = shape.fromKeys.has(key) ? "a key of from" : shape.argsKeys?.has(key) === true || shape.captureKeys.has(key) ? "an args key" : null;
    if (other !== null) {
      throw new InvalidClaimError(`events.${key} has the name of ${other}, so a claim's actual "${key}" would have two sources. Rename one of them`);
    }
    if (!claims.some((claim) => claim.actual === key)) {
      throw new InvalidClaimError(
        `events.${key} is read by no claim, so the count it names changes no verdict. Compare a claim with actual "${key}", or take the key out of events`,
      );
    }
  }
  for (const value of events.sentenceValues) {
    const label = `events.${value.key}.count.${value.field}`;
    if (shape.fromKeys.has(value.name)) {
      throw new InvalidClaimError(`${label} takes { sentence: "${value.name}" }, which from fills from an earlier step, and a selection takes a value the line states`);
    }
    if (shape.argsKeys !== null && !shape.argsKeys.has(value.name)) {
      throw new InvalidClaimError(`${label} takes { sentence: "${value.name}" }, which is not a key of args`);
    }
    if (shape.requiredArgsKeys !== null && !shape.requiredArgsKeys.has(value.name)) {
      throw new InvalidClaimError(
        `${label} takes { sentence: "${value.name}" }, which args lets a line leave out (it is optional or has a default), so step code would fill what the count selects. Make it required`,
      );
    }
    checkNotRewritten(label, value.name, shape, "expected");
  }
}

type Where = "actual" | "item";

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function checkPath(label: string, path: unknown, optional: boolean): void {
  if (path === undefined && optional) return;
  if (typeof path !== "string" || pathSegments(path) === null) {
    throw new InvalidClaimError(`${label} must be a path of dot-separated keys, such as "result.exit_code"; got ${describe(path)}`);
  }
}

// The keys each kind of declaration has. A key outside its list is refused,
// naming it: a misspelled `at` would otherwise be ignored, and the claim
// would read another place than the one its author wrote.
const COMPARISON_KEYS = ["actual", "view", "at", "count", "compare", "expected", "expected_view"] as const;
const EACH_CLAIM_KEYS = ["actual", "view", "at", "each"] as const;
const EACH_KEYS = ["where", "claims"] as const;

function checkKeys(label: string, value: object, allowed: readonly string[], what: string): void {
  // A key set to undefined reads as absent, as the declaration types allow.
  const unknown = Object.entries(value).find(([key, entry]) => entry !== undefined && !allowed.includes(key))?.[0];
  if (unknown !== undefined) {
    throw new InvalidClaimError(`${label} has the key "${unknown}", which ${what} does not have. It has ${allowed.join(", ")}`);
  }
}

function checkCommon(label: string, claim: { view?: unknown; at?: unknown }): void {
  if (claim.view !== undefined && !(CLAIM_VIEWS as readonly unknown[]).includes(claim.view)) {
    throw new InvalidClaimError(`${label}.view must be one of ${CLAIM_VIEWS.join(", ")}; got ${describe(claim.view)}`);
  }
  checkPath(`${label}.at`, claim.at, true);
}

/** Refuses a claim that reads an args key whose schema rewrites the value. */
function checkNotRewritten(label: string, key: string, shape: ClaimStepShape, side: "actual" | "expected"): void {
  const where = side === "actual" ? "the value the claim measures" : "the value the line states or an earlier step returned";
  if (shape.argsRewrite !== undefined && shape.argsRewrite !== null) {
    throw new InvalidClaimError(
      `${label} reads args.${key}, and the args schema itself rewrites ${where} (${shape.argsRewrite}), so step code would decide what the claim compares. Take the rewrite out of the args schema`,
    );
  }
  const rewrite = shape.rewrittenArgs.get(key);
  if (rewrite === undefined) return;
  throw new InvalidClaimError(
    `${label} reads args.${key}, and its schema rewrites ${where} (${rewrite}), so step code would decide what the claim compares. Take the rewrite out of the schema` +
      (side === "expected" ? `, or read the line's text with expected_view (${CLAIM_VIEWS.join(", ")})` : ""),
  );
}

function checkExpectedView(label: string, claim: Record<string, unknown>, shape: ClaimStepShape): void {
  const view = claim.expected_view;
  if (view === undefined) return;
  if (!(CLAIM_VIEWS as readonly unknown[]).includes(view)) {
    throw new InvalidClaimError(`${label}.expected_view must be one of ${CLAIM_VIEWS.join(", ")}; got ${describe(view)}`);
  }
  if (typeof claim.expected !== "string") {
    throw new InvalidClaimError(
      `${label}.expected_view reads the text a line states, and ${label}.expected is not an args key the sentence fills`,
    );
  }
  if (shape.stringArgs !== null && !shape.stringArgs.has(claim.expected)) {
    throw new InvalidClaimError(
      `${label}.expected_view reads text, and args.${claim.expected} is not a plain z.string(), so the line's text is not what reaches the view`,
    );
  }
}

function checkExpected(label: string, expected: unknown, compare: unknown, shape: ClaimStepShape, actualFromObserve: boolean): void {
  if (typeof expected === "string") {
    if (shape.fromKeys.has(expected)) {
      throw new InvalidClaimError(
        `${label}.expected names "${expected}", which from fills from an earlier step. Write { from: "${expected}" } so the record says so`,
      );
    }
    if (shape.argsKeys !== null && !shape.argsKeys.has(expected)) {
      throw new InvalidClaimError(`${label}.expected names "${expected}", which is not a key of args`);
    }
    // A default or an optional key would let the schema in step code fill
    // the expected value when the line states none, which is the value in
    // code again.
    if (shape.requiredArgsKeys !== null && !shape.requiredArgsKeys.has(expected)) {
      throw new InvalidClaimError(
        `${label}.expected names "${expected}", which args lets a line leave out (it is optional or has a default). An expected value the sentence fills must be required, so it comes from the line and never from step code`,
      );
    }
    checkNotRewritten(`${label}.expected`, expected, shape, "expected");
    return;
  }
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    throw new InvalidClaimError(
      `${label}.expected must be an args key the sentence fills, { from }, { literal }, or { observe }; got ${describe(expected)}`,
    );
  }
  const keys = Object.keys(expected);
  if (keys.length !== 1) {
    throw new InvalidClaimError(`${label}.expected must have exactly one of from, literal, observe; got ${describe(keys)}`);
  }
  const record = expected as Record<string, unknown>;
  if ("from" in record) {
    checkPath(`${label}.expected.from`, record.from, false);
    const key = pathSegments(record.from as string)![0]!;
    if (!shape.fromKeys.has(key)) {
      throw new InvalidClaimError(`${label}.expected.from starts with "${key}", which is not a key of this step's from`);
    }
    if (shape.captureKeys.has(key)) {
      throw new InvalidClaimError(
        `${label}.expected.from starts with "${key}", which a pattern captures, so a line fills it and no earlier step does. Name it as a sentence key, or take it out of the pattern`,
      );
    }
    checkNotRewritten(`${label}.expected.from`, key, shape, "expected");
    return;
  }
  if ("observe" in record) {
    checkPath(`${label}.expected.observe`, record.observe, false);
    if (!shape.hasObserve) {
      throw new InvalidClaimError(`${label}.expected reads observe, and the step has no observe`);
    }
    return;
  }
  if ("literal" in record) {
    const literal = record.literal;
    if (!isLiteralValue(literal)) {
      throw new InvalidClaimError(
        `${label}.expected.literal must be a string, a finite number, a boolean, null, or []; got ${describe(literal)}`,
      );
    }
    if (typeof literal === "boolean" && actualFromObserve) {
      throw new InvalidClaimError(
        `${label}.expected is the boolean ${String(literal)}, and its actual comes from observe. A boolean computed by observe is a judgment made in code: return the thing measured (a count, a text, a list) and let the claim compare it`,
      );
    }
    const statements = shape.patterns.map((pattern) => literalStatement(pattern, literal));
    const statement = literalStatementOfAll(shape.patterns, literal);
    if (statement === null) {
      const where =
        shape.patterns.length === 0
          ? "the step has no pattern, so no sentence states it"
          : `no fixed word of ${shape.patterns.map((pattern) => `"${pattern}"`).join(" and ")} states it`;
      throw new InvalidClaimError(
        `${label}.expected is the literal ${describe(literal)}, and ${where}. Put the value in the sentence, as fixed words or as a capture the claim names`,
      );
    }
    // Every pattern a line may bind has to allow the compare: a step whose
    // patterns say "is empty" and "is not empty" can claim neither.
    for (const stated of statements) {
      if (stated === null || stated.compare === null || stated.compare === compare) continue;
      const words = stated.compare === "not-equal" ? `words "${(stated.negatedBy ?? "not").toLowerCase()} ${stated.words}" rule out` : `word "${stated.words}" fixes`;
      throw new InvalidClaimError(
        `${label}.expected is the literal ${describe(literal)}, which the ${words}, and ${label}.compare is ${describe(compare)}. A value a word fixes is compared with equal alone, or with not-equal alone right after the word "not", "neither", or "nor" ("is not empty"): another compare against it holds for nearly anything, and the word does not show it`,
      );
    }
    return;
  }
  throw new InvalidClaimError(`${label}.expected must have exactly one of from, literal, observe; got ${describe(keys)}`);
}

/** What a claim's view or expected_view always makes, by its JSON type:
 * the view reads a string, and gives this or a reason. */
const VIEW_MAKES: Readonly<Record<(typeof CLAIM_VIEWS)[number], "string" | "array" | null>> = {
  text: "string",
  lines: "array",
  "comma-list": "array",
  json: null,
};

function literalOf(expected: unknown): { readonly literal: unknown } | null {
  return typeof expected === "object" && expected !== null && "literal" in expected ? (expected as { literal: unknown }) : null;
}

/** The refusals a compare adds to the expected value it may take, by
 * compare: an expected value the compare always breaks on, or one that
 * states nothing. Each holds only what can end one way, so the run would
 * meet the same thing on every line. A compare with no row adds none. */
const COMPARE_SIDES: Partial<Record<ClaimCompare, (label: string, claim: Record<string, unknown>) => void>> = {
  // A literal is a word or a number, and a sentence key holds a capture's
  // value, a docstring, or a table's cells, so only JSON read from the
  // line can be the object has-fields compares with.
  "has-fields": (label, claim) => {
    const literal = literalOf(claim.expected);
    if (literal !== null) {
      throw new InvalidClaimError(
        `${label}.expected is the literal ${describe(literal.literal)}, which is never an object, and has-fields compares two objects, so the claim always breaks. Take the expected object from the docstring, read as JSON with expected_view: "json"`,
      );
    }
    if (typeof claim.expected !== "string" || claim.expected_view === "json") return;
    const view = claim.expected_view as (typeof CLAIM_VIEWS)[number] | undefined;
    const what =
      view === undefined
        ? `is args.${claim.expected}, which a line fills with a capture's value, the docstring's text, or the table's cells`
        : `reads args.${claim.expected} through expected_view ${view}, which makes ${article(VIEW_MAKES[view]!)}`;
    throw new InvalidClaimError(`${label}.expected ${what}, never an object, so has-fields always breaks. Read the docstring as JSON with expected_view: "json"`);
  },
  // The expected side names one field, so it is a word and never a list,
  // and a field can be absent only from an object: a view that always
  // makes a string or an array leaves no field to lack.
  "lacks-field": (label, claim) => {
    const literal = literalOf(claim.expected);
    if (literal !== null && typeof literal.literal !== "string") {
      throw new InvalidClaimError(
        `${label}.expected is the literal ${describe(literal.literal)}, which is never the name of a field, and lacks-field names the field its actual object lacks, so the claim always breaks. State the field's name in the pattern's fixed words`,
      );
    }
    const expectedView = claim.expected_view as (typeof CLAIM_VIEWS)[number] | undefined;
    if (expectedView !== undefined && VIEW_MAKES[expectedView] === "array") {
      throw new InvalidClaimError(
        `${label}.expected reads args.${String(claim.expected)} through expected_view ${expectedView}, which makes an array and never the name of a field, so lacks-field always breaks. Name one field, and leave expected_view out`,
      );
    }
    const view = claim.view as (typeof CLAIM_VIEWS)[number] | undefined;
    const made = view === undefined || claim.at !== undefined ? null : VIEW_MAKES[view];
    if (made !== null) {
      throw new InvalidClaimError(
        `${label} reads its actual value through view ${view!}, which always makes ${article(made)} and never an object, so lacks-field always breaks. Read the text with view json, or claim a value that is an object`,
      );
    }
  },
  // The stand-ins are read in the expected text wherever it came from, so
  // an expected text a program wrote is a template nobody stated: a first
  // run that printed a "..." line lets a second run print any lines there.
  "fits-text": (label, claim) => {
    const expected = claim.expected;
    if (typeof expected !== "object" || expected === null || literalOf(expected) !== null) return;
    const source = "from" in expected ? ["from", "a value a step returned"] : "observe" in expected ? ["observe", "a value observe read"] : null;
    if (source === null) return;
    const [key, what] = source;
    throw new InvalidClaimError(
      `${label}.expected reads { ${key}: ${describe((expected as Record<string, unknown>)[key!])} }, ${what}, and fits-text reads each "..." line and each "[..]" of its expected text as a stand-in, so a value that holds one lets text nobody stated fit. Take the expected text from the sentence: a docstring, a capture, or a literal`,
    );
  },
  // A literal is the one expected value known before a line binds, so it
  // is the one this can judge: a name that is no kind breaks on every line,
  // and a kind the view always makes (text makes a string, lines and
  // comma-list an array) holds whenever the view applies. An `at` reads
  // inside the viewed value, which can be of any kind.
  "is-a": (label, claim) => {
    const literal = literalOf(claim.expected);
    if (literal === null) return;
    const kind = typeof literal.literal === "string" ? kindNamed(literal.literal) : undefined;
    if (kind === undefined) {
      throw new InvalidClaimError(
        `${label}.expected is the literal ${describe(literal.literal)}, and is-a names one of the kinds ${VALUE_KINDS.join(", ")}, so the claim always breaks. State one of them in the pattern's fixed words`,
      );
    }
    const view = claim.view as (typeof CLAIM_VIEWS)[number] | undefined;
    const made = view === undefined || claim.at !== undefined ? null : VIEW_MAKES[view];
    if (made === null || VIEW_KIND_TYPES[kind] !== made) return;
    const instead = made === "string" ? "Name a kind a string may not be, such as uuid, date, timestamp, or url, or claim the value itself" : "Claim what its items are with each, or claim the value itself";
    throw new InvalidClaimError(
      `${label} reads its actual value through view ${view}, which always makes ${article(made)}, so is-a ${describe(literal.literal)} holds whenever the view applies and states nothing. ${instead}`,
    );
  },
};

/** Each kind that holds for every value of one JSON type, with that type. */
const VIEW_KIND_TYPES: Partial<Record<ValueKind, "string" | "array">> = { string: "string", text: "string", list: "array", array: "array" };

function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** The compares a count can take. A count is a number, so any other
 * compare on it breaks on every line, or, for is-a, holds on every one. */
export const COUNT_COMPARES: readonly ClaimCompare[] = ["equal", "not-equal", "greater-than", "at-least", "less-than", "at-most"];

/** Refuses a `count` the run would judge one way on every line: a count
 * makes a number, so a compare that reads anything else, an expected
 * literal or `expected_view` that is never a number, and a view that
 * always makes a string with no `at` after it leave nothing to measure. */
function checkCount(label: string, claim: Record<string, unknown>): void {
  if (claim.count === undefined) return;
  if (claim.count !== true) throw new InvalidClaimError(`${label}.count must be true, or left out; got ${describe(claim.count)}`);
  const makes = `${label} counts the items of its actual value, which makes a number`;
  if (!(COUNT_COMPARES as readonly unknown[]).includes(claim.compare)) {
    throw new InvalidClaimError(
      `${makes}, and ${String(claim.compare)} does not compare two numbers, so the claim would break on every line or hold on every line. Compare the count with ${COUNT_COMPARES.join(", ")}`,
    );
  }
  if (claim.view === "text" && claim.at === undefined) {
    throw new InvalidClaimError(`${label} counts the items of a value read through view text, which always makes a string and never an array, so the claim always breaks. Read the text with view lines to count its lines`);
  }
  const literal = literalOf(claim.expected);
  if (literal !== null && typeof literal.literal !== "number") {
    throw new InvalidClaimError(
      `${makes}, and its expected value is the literal ${describe(literal.literal)}, which is never a number, so the claim always breaks. State the number in the pattern, as digits or a number word, and write it as a number literal`,
    );
  }
  const view = claim.expected_view as (typeof CLAIM_VIEWS)[number] | undefined;
  const viewMakes = view === undefined ? null : VIEW_MAKES[view];
  if (viewMakes !== null) {
    throw new InvalidClaimError(
      `${makes}, and its expected value is read through expected_view ${view!}, which makes ${article(viewMakes)} and never a number, so the claim always breaks. Capture the number with {int}, or leave expected_view out`,
    );
  }
}

/** Refuses a `fits-aria-snapshot` claim the run could not judge as the
 * line states it. Its actual value is the ARIA snapshot nukadoko takes of
 * the locator or page `observe` returns at `actual`, so it reads nothing an
 * earlier step returned (plain JSON, never a locator) and nothing inside an
 * `each` item, and nothing (a view, an `at`, a count) stands between the
 * value and the snapshot. Its expected tree is the text the line states,
 * read as it is: a tree a step returned or `observe` read would be one a
 * program wrote, so it could be the actual tree copied, and the claim
 * would hold whatever the page shows. */
function checkAriaSnapshot(label: string, claim: Record<string, unknown>, where: Where, actualFromObserve: boolean): void {
  const takes = "fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns";
  if (where === "item") {
    throw new InvalidClaimError(
      `${label} compares with fits-aria-snapshot, and an item of each is plain JSON, never a locator or a page, while ${takes}, so the claim always breaks. Claim the snapshot at the top level, with actual naming the key observe returns it under`,
    );
  }
  if (!actualFromObserve) {
    throw new InvalidClaimError(
      `${label}.actual reads a value an earlier step returned, which is plain JSON and never a locator or a page, and ${takes}, so the claim always breaks. Return the locator or page from observe, and name its key in actual`,
    );
  }
  for (const key of ["view", "at", "count"] as const) {
    if (claim[key] === undefined) continue;
    throw new InvalidClaimError(
      `${label} has ${key}, and ${takes} at actual, with nothing between the value and the snapshot. Name the locator or page in actual, and drop ${key}`,
    );
  }
  const expected = claim.expected;
  const literal = literalOf(expected);
  if (literal !== null) {
    throw new InvalidClaimError(
      `${label}.expected is the literal ${describe(literal.literal)}, and the expected ARIA snapshot of fits-aria-snapshot is a tree of lines the line states, which the pattern's fixed words are not. Take the expected snapshot from the docstring`,
    );
  }
  if (typeof expected === "object" && expected !== null) {
    const source = "from" in expected ? "a value a step returned" : "a value observe read";
    throw new InvalidClaimError(
      `${label}.expected reads ${describe(expected)}, ${source}, and the expected ARIA snapshot of fits-aria-snapshot is the tree the line states: a tree a program wrote could be the actual tree copied, so the claim would hold whatever the page shows. Take the expected snapshot from the docstring`,
    );
  }
  if (claim.expected_view !== undefined) {
    throw new InvalidClaimError(
      `${label}.expected_view is ${describe(claim.expected_view)}, and fits-aria-snapshot reads the expected ARIA snapshot from the text the line states, as it is. Drop expected_view`,
    );
  }
}

function checkComparison(label: string, claim: Record<string, unknown>, shape: ClaimStepShape, where: Where, actualFromObserve: boolean): void {
  if (claim.each !== undefined) {
    throw new InvalidClaimError(`${label} has each, which a claim inside each cannot have`);
  }
  checkKeys(label, claim, COMPARISON_KEYS, where === "item" ? "a claim on one item" : "a claim");
  checkPath(`${label}.actual`, claim.actual, where === "item");
  checkCommon(label, claim);
  if (!(CLAIM_COMPARES as readonly unknown[]).includes(claim.compare)) {
    throw new InvalidClaimError(`${label}.compare must be one of ${CLAIM_COMPARES.join(", ")}; got ${describe(claim.compare)}`);
  }
  checkExpected(label, claim.expected, claim.compare, shape, actualFromObserve);
  checkExpectedView(label, claim, shape);
  checkCount(label, claim);
  COMPARE_SIDES[claim.compare as ClaimCompare]?.(label, claim);
  // Not a row of COMPARE_SIDES: it needs to know where the claim sits and
  // what its actual reads.
  if (claim.compare === ARIA_SNAPSHOT_COMPARE) checkAriaSnapshot(label, claim, where, actualFromObserve);
}

/** Whether a top-level claim's `actual` reads observe: it is not an
 * events key, and its first segment is not a `from` key. */
export function actualReadsObserve(actual: string, fromKeys: ReadonlySet<string>, eventsKeys: ReadonlySet<string> = NO_EVENTS.keys): boolean {
  return !eventsKeys.has(actual) && !fromKeys.has(pathSegments(actual)?.[0] ?? "");
}

/** Why `defineStep` must not store this claim list, naming the claim by
 * its index, or `null`. Pure. */
export function claimsProblem(claims: unknown, shape: ClaimStepShape): string | null {
  return problemOf(() => validateClaims(claims, shape));
}

/** Why this `poll` value is refused, or `null`. Pure. */
export function pollProblem(poll: unknown, hasObserve: boolean, maxMs: number): string | null {
  return problemOf(() => validatePoll(poll, hasObserve, maxMs));
}

function problemOf(check: () => void): string | null {
  try {
    check();
    return null;
  } catch (error) {
    if (error instanceof InvalidClaimError) return error.message;
    throw error;
  }
}

function validateClaims(claims: unknown, shape: ClaimStepShape): void {
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new InvalidClaimError(
      "claims must be a non-empty array. A claim step with no claim passes without judging anything",
    );
  }
  claims.forEach((raw: unknown, index) => {
    const label = `claims[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new InvalidClaimError(`${label} must be an object with actual, compare, and expected, or actual and each`);
    }
    const claim = raw as Record<string, unknown>;
    checkPath(`${label}.actual`, claim.actual, false);
    const segments = pathSegments(claim.actual as string)!;
    const head = segments[0]!;
    const eventsKeys = shape.events?.keys ?? NO_EVENTS.keys;
    if (eventsKeys.has(claim.actual as string)) {
      checkEventsClaim(label, claim, claim.actual as string, shape);
      return;
    }
    if (eventsKeys.has(head)) {
      throw new InvalidClaimError(
        `${label}.actual reads inside events.${head}, a count of execution events, which is one number with nothing inside it. Name the key alone: actual "${head}"`,
      );
    }
    const fromObserve = !shape.fromKeys.has(head);
    if (fromObserve && !shape.hasObserve) {
      throw new InvalidClaimError(
        `${label}.actual starts with "${head}", which is not a key of this step's from, and the step has no observe to read it`,
      );
    }
    if (!fromObserve && shape.captureKeys.has(head)) {
      throw new InvalidClaimError(
        `${label}.actual starts with "${head}", which a pattern captures, so a line would fill the value the claim measures. Take it out of the pattern, so an earlier step fills it`,
      );
    }
    if (fromObserve && shape.argsKeys?.has(head) === true) {
      throw new InvalidClaimError(
        `${label}.actual starts with "${head}", an args key the sentence fills. A claim's actual is a value an earlier step returned (a from key) or one observe read`,
      );
    }
    if (!fromObserve) checkNotRewritten(`${label}.actual`, head, shape, "actual");
    if (claim.each === undefined) {
      checkComparison(label, claim, shape, "actual", fromObserve);
      return;
    }
    if (claim.compare !== undefined || claim.expected !== undefined) {
      throw new InvalidClaimError(`${label} has both each and compare/expected. A claim compares one value, or applies each to an array`);
    }
    checkKeys(label, claim, EACH_CLAIM_KEYS, "a claim with each");
    checkCommon(label, claim);
    const each = claim.each as Record<string, unknown> | null;
    if (typeof each !== "object" || each === null || !Array.isArray(each.claims) || each.claims.length === 0) {
      throw new InvalidClaimError(`${label}.each.claims must be a non-empty array of claims on one item`);
    }
    checkKeys(`${label}.each`, each, EACH_KEYS, "each");
    if (each.where !== undefined && (!Array.isArray(each.where) || each.where.length === 0)) {
      throw new InvalidClaimError(`${label}.each.where must be a non-empty array of claims on one item, or left out`);
    }
    for (const [list, entries] of [["where", each.where ?? []], ["claims", each.claims]] as const) {
      (entries as unknown[]).forEach((entry, itemIndex) => {
        const itemLabel = `${label}.each.${list}[${itemIndex}]`;
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw new InvalidClaimError(`${itemLabel} must be an object with compare and expected`);
        }
        checkComparison(itemLabel, entry as Record<string, unknown>, shape, "item", fromObserve);
      });
    }
    // A where clause whose place overlaps an item claim's, and whose
    // compare decides the value there (equal, has-same-items), or selects
    // by a part or a kind of it no claim can be told apart from
    // (has-fields, lacks-field, fits-text, is-a, contains-text,
    // starts-with-text, ends-with-text, matches, has-item),
    // selects the items by the value the claim then judges: "every item
    // that is done is done". An order compare or not-equal leaves a range
    // the claim can still break on ("every item over 10 costs at most
    // 100"), so the run judges that pair on its values
    // (`whereImplies`).
    ((each.where ?? []) as Record<string, unknown>[]).forEach((entry, whereIndex) => {
      if (!WHERE_DECIDES.has(entry["compare"] as string)) return;
      const place = itemReadPath(entry);
      const overlapping = (each.claims as Record<string, unknown>[]).findIndex((item) => itemPathsOverlap(itemReadPath(item), place));
      if (overlapping === -1) return;
      const other = itemReadPath((each.claims as Record<string, unknown>[])[overlapping]!);
      const relation = other.length === place.length ? "the same place" : other.length > place.length ? "a place inside it" : "a place that holds it";
      throw new InvalidClaimError(
        `${label}.each.where[${whereIndex}] selects by ${describeItemPath(place)} with ${String(entry["compare"])}, and ${label}.each.claims[${overlapping}] reads ${describeItemPath(other)}, ${relation}, so where selects the items by the value the claim then judges and "every item" says nothing. Select by another value, or drop where`,
      );
    });
  });
  // An observe no claim reads changes no verdict, and the likely cause is
  // a key it returns under a from key's name: the from value wins, so the
  // reading is never compared and nothing says so.
  checkEvents(claims as readonly Record<string, unknown>[], shape);
  if (shape.hasObserve && !claimsReadObserve(claims as readonly Claim[], shape.fromKeys, shape.events?.keys)) {
    throw new InvalidClaimError(
      "the step has observe, and no claim reads what it returns: every claim's actual is a key of from, and no expected value is { observe }. " +
        "A key observe returns under a from key's name never reaches a claim, since the from value wins. " +
        "Rename the key observe returns so no from key has its name, or drop observe",
    );
  }
  // A value the line states that no claim reads, in a step with no observe
  // to receive it, is a value nothing checks: the line says more than the
  // step judges. The docstring or table key is known only per line, so
  // `nuka check` and the run report that half (`claim-sentence-unread`).
  if (!shape.hasObserve) {
    const read = new Set([...claimArgKeysRead(claims as readonly Claim[]), ...eventsSentenceKeys(shape.events ?? NO_EVENTS)]);
    const unread = [...shape.captureKeys].find((key) => !read.has(key));
    if (unread !== undefined) {
      throw new InvalidClaimError(
        `the pattern captures "${unread}", and no claim reads it, and the step has no observe to receive it, so nothing checks the value the line states. ` +
          `Compare a claim with "${unread}", or take it out of the pattern`,
      );
    }
  }
}

/** The args keys `observe` never receives: each key a claim names as its
 * expected value (a sentence key, or the head of a `{ from }` path), and
 * the `from` key a claim's actual starts with when that claim, or an item
 * claim under its `each`, takes its expected value from `observe`.
 * Holding back the first keeps the expected value out of `observe`'s
 * hands; holding back the second keeps the actual value out of them, so
 * `observe` cannot return what it will be compared with either way. Each
 * key maps to the side a claim reads it on, `expected` when it is both.
 * Pure. */
export function observeWithheldKeys(claims: readonly Claim[], fromKeys: ReadonlySet<string>): ReadonlyMap<string, "expected" | "actual"> {
  const keys = new Map<string, "expected" | "actual">();
  const expectedKey = (key: string): void => void keys.set(key, "expected");
  for (const claim of claims) {
    const entries: readonly ItemClaim[] = isEachClaim(claim) ? [...(claim.each.where ?? []), ...claim.each.claims] : [claim];
    for (const entry of entries) {
      const expected = entry.expected as unknown;
      if (typeof expected === "string") expectedKey(expected);
      else if (typeof expected === "object" && expected !== null && "from" in expected) {
        const head = pathSegments(String((expected as { from: unknown }).from))?.[0];
        if (head !== undefined) expectedKey(head);
      } else if (typeof expected === "object" && expected !== null && "observe" in expected) {
        const head = pathSegments(claim.actual)?.[0];
        if (head !== undefined && fromKeys.has(head) && !keys.has(head)) keys.set(head, "actual");
      }
    }
  }
  return keys;
}

/** Whether any claim reads what `observe` returns: an actual whose first
 * segment is not a from key, or an expected `{ observe }`, in a claim or
 * in an `each`'s `where` and item claims. Pure. */
export function claimsReadObserve(claims: readonly Claim[], fromKeys: ReadonlySet<string>, eventsKeys: ReadonlySet<string> = NO_EVENTS.keys): boolean {
  return claims.some((claim) => {
    if (actualReadsObserve(claim.actual, fromKeys, eventsKeys)) return true;
    const entries: readonly ItemClaim[] = isEachClaim(claim) ? [...(claim.each.where ?? []), ...claim.each.claims] : [claim];
    return entries.some((entry) => typeof entry.expected === "object" && entry.expected !== null && "observe" in entry.expected);
  });
}

/** Why a claim step does not judge the value its line's docstring or
 * table states: the attachment fills `key`, no claim reads it, and the
 * step has no `observe` to receive it. `null` when something reads it.
 * `nuka check` reports this reason (`claim-sentence-unread`) and the run
 * breaks the step's claims with it, since only the line says whether a
 * docstring or a table fills a key. Pure. */
export function sentenceUnreadReason(
  claims: readonly Claim[],
  hasObserve: boolean,
  key: string,
  attachment: "docstring" | "table",
  events: EventsShape = NO_EVENTS,
): string | null {
  if (hasObserve || claimArgKeysRead(claims).has(key) || eventsSentenceKeys(events).has(key)) return null;
  return `the ${attachment} of the line fills args.${key}, which no claim reads, and the step has no observe to receive it, so nothing checks the value the line states`;
}

/** The args keys a step's claims read: the key an `actual` path starts
 * with, a sentence key named as an expected value, and the key a
 * `{ from }` expected path starts with, in every claim and in an
 * `each`'s `where` and item claims. Pure. */
export function claimArgKeysRead(claims: readonly Claim[]): ReadonlySet<string> {
  const keys = new Set<string>();
  const addPath = (path: string): void => {
    const head = pathSegments(path)?.[0];
    if (head !== undefined) keys.add(head);
  };
  const addExpected = (expected: ClaimExpected): void => {
    if (typeof expected === "string") keys.add(expected);
    else if ("from" in expected) addPath(expected.from);
  };
  for (const claim of claims) {
    addPath(claim.actual);
    if (!isEachClaim(claim)) addExpected(claim.expected);
    else for (const item of [...(claim.each.where ?? []), ...claim.each.claims]) addExpected(item.expected);
  }
  return keys;
}

/** The compares a `where` clause may not use on a place that overlaps an
 * item claim's: each decides the value there, or selects by a part or a
 * kind of it that the claim cannot be told apart from. */
const WHERE_DECIDES: ReadonlySet<string> = new Set(["equal", "has-same-items", "has-fields", "lacks-field", "fits-text", "is-a", "contains-text", "starts-with-text", "ends-with-text", "matches", "has-item"]);

/** Whether two places inside one item overlap: one path is the start of
 * the other, after `actual` and `at` are joined (`itemPath`). Pure. */
export function itemPathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** The place inside one item that an item claim reads, as path segments:
 * its `actual` path (none for the item itself) followed by its `at`
 * path. `view` is left out on purpose: a view reads the same value
 * another way, so a where clause and an item claim that differ only by a
 * view read one value. Pure. */
export function itemPath(claim: { readonly actual?: unknown; readonly at?: unknown }): readonly string[] {
  const split = (path: unknown): readonly string[] => (typeof path === "string" ? (pathSegments(path) ?? [path]) : []);
  return [...split(claim.actual), ...split(claim.at)];
}

/** The place inside an item a claim reads to judge it: its path, and
 * for a lacks-field claim whose field is a literal, that field under it,
 * so a where clause that selects the items with no deleted_at field
 * leaves a claim on their status to the data. A field the line fills is
 * not known before a line binds, so such a claim reads its whole object
 * here. Pure. */
function itemReadPath(claim: Record<string, unknown>): readonly string[] {
  const path = itemPath(claim);
  if (claim.compare !== "lacks-field") return path;
  const literal = literalOf(claim.expected);
  return literal !== null && typeof literal.literal === "string" ? [...path, literal.literal] : path;
}

function describeItemPath(segments: readonly string[]): string {
  return segments.length === 0 ? "the item itself" : `the item at ${segments.join(".")}`;
}

function validatePoll(poll: unknown, hasObserve: boolean, maxMs: number): void {
  if (poll === undefined) return;
  if (poll !== false) {
    const timeout = typeof poll === "object" && poll !== null ? (poll as { timeout_ms?: unknown }).timeout_ms : undefined;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > maxMs || Object.keys(poll as object).length !== 1) {
      throw new InvalidClaimError(
        `poll must be false or { timeout_ms } with a number of milliseconds greater than 0 and at most ${maxMs}; got ${describe(poll)}`,
      );
    }
  }
  if (poll !== false && !hasObserve) {
    throw new InvalidClaimError(
      "poll re-runs observe, and the step has no observe. Values from earlier steps do not change between readings",
    );
  }
}

// --- one line per claim, for nuka steps and nuka describe ---

function describeExpected(expected: ClaimExpected): string {
  if (typeof expected === "string") return expected;
  if ("from" in expected) return `from ${expected.from}`;
  if ("observe" in expected) return `observe ${expected.observe}`;
  return JSON.stringify(expected.literal);
}

function describeComparison(claim: ItemClaim, actual: string): string {
  const view = claim.view === undefined ? "" : ` as ${claim.view}`;
  const at = claim.at === undefined ? "" : ` at ${claim.at}`;
  const expectedView = claim.expected_view === undefined ? "" : ` as ${claim.expected_view}`;
  const count = claim.count === true ? "count of " : "";
  return `${count}${actual}${view}${at} ${claim.compare} ${describeExpected(claim.expected)}${expectedView}`;
}

/** A declared claim as one line: `result.exit_code equal code`, with a
 * `from`, `observe`, or JSON literal expected value named as such, and
 * `count of orders equal n` for a claim that counts. Pure. */
export function describeClaim(claim: Claim): string {
  if (!isEachClaim(claim)) return describeComparison(claim, claim.actual);
  const view = claim.view === undefined ? "" : ` as ${claim.view}`;
  const at = claim.at === undefined ? "" : ` at ${claim.at}`;
  const item = (entry: ItemClaim): string => describeComparison(entry, entry.actual ?? "item");
  const where = claim.each.where === undefined ? "" : ` where ${claim.each.where.map(item).join(" and ")}`;
  return `each of ${claim.actual}${view}${at}${where}: ${claim.each.claims.map(item).join(" and ")}`;
}
