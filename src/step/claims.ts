import type { ClaimCompare, ClaimView } from "../record/types.js";

// Responsibility: what a claim step declares in place of `run`
// (docs/spec.md "Claims"), and the rules a declaration must pass before
// `defineStep` stores it. A Then step does not judge in code: it names the
// value it reads (`actual`), where the value it compares with comes from
// (`expected`), and how the two compare, and nukadoko does the judging, so
// the expected value is in the sentence or in an earlier step's result,
// never in step code. This module holds the declaration types, the path
// syntax both sides share, and the literal rule. It does not evaluate a
// claim (src/step/evaluate-claims.ts does) and does not read a feature file
// (`nuka check` resolves a claim against the line that binds it).

/** Every compare a claim may name. */
export const CLAIM_COMPARES = [
  "equal",
  "not-equal",
  "contains-text",
  "has-item",
  "matches",
  "greater-than",
  "at-least",
  "less-than",
  "at-most",
] as const satisfies readonly ClaimCompare[];

/** Every view a claim may name. */
export const CLAIM_VIEWS = ["text", "lines", "json"] as const satisfies readonly ClaimView[];

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

function sameSegment(a: string, b: string): boolean {
  return a === b || (a === ANY_INDEX && INDEX_SEGMENT.test(b)) || (b === ANY_INDEX && INDEX_SEGMENT.test(a));
}

/** Whether two places read the same value. Pure. */
export function samePlace(a: Pick<ClaimPlace, "origin" | "segments">, b: Pick<ClaimPlace, "origin" | "segments">): boolean {
  return a.origin === b.origin && a.segments.length === b.segments.length && a.segments.every((segment, index) => sameSegment(segment, b.segments[index]!));
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
// pattern's fixed words, joined by one space, or it is the fixed value of
// a fixed word in the table below. A word inside a capture, an optional
// group, or an alternation is not fixed, because the sentence a line binds
// may not say it. Only the pattern side is normalized (edge punctuation
// taken off its words): a literal with other spacing or punctuation is a
// text the sentence does not state.
//
// A value from the table is compared with `equal` alone. "no item is
// unpaid" read as `at-least 0`, or "the cart is empty" read as
// `not-equal []`, would hold for nearly anything, and the word gives
// the reader no way to see that.

/** The values a word fixes, compared case-insensitively. */
export const LITERAL_WORDS: Readonly<Record<string, readonly ClaimLiteral[]>> = {
  no: [0, "", []],
  none: [0, "", []],
  nothing: [0, "", []],
  empty: ["", []],
};

const EDGE_PUNCTUATION = /^[.,;:!?"'`]+|[.,;:!?"'`]+$/g;

function normalizedWord(word: string): string {
  return word.replace(EDGE_PUNCTUATION, "");
}

/** The words of `pattern` a matching sentence always contains, in order,
 * with edge punctuation removed. A word that holds a capture, an optional
 * group, or an alternation is left out. Pure. */
export function fixedWords(pattern: string): readonly string[] {
  const words: string[] = [];
  let word = "";
  let fixed = true;
  const end = (): void => {
    const normalized = normalizedWord(word);
    if (fixed && normalized.length > 0) words.push(normalized);
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
 * (`literal:<words>`), and `byTable` when a word of the table fixes the
 * value rather than the literal's own text being the words. */
export interface LiteralStatement {
  readonly words: string;
  readonly byTable: boolean;
}

/** How `pattern` states `literal`, or `null` when it does not. Pure. */
export function literalStatement(pattern: string, literal: unknown): LiteralStatement | null {
  const words = fixedWords(pattern);
  const text = literalText(literal);
  if (text !== null && text.length > 0 && isRunOf(words, text)) return { words: text, byTable: false };
  for (const word of words) {
    const values = LITERAL_WORDS[word.toLowerCase()];
    if (values?.some((value) => sameLiteral(literal, value))) return { words: word, byTable: true };
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
  return { words: stated[0]!.words, byTable: stated.some((statement) => statement!.byTable) };
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
      (side === "expected" ? ", or read the line's text with expected_view (text, lines, or json)" : ""),
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
    if (statement.byTable && compare !== "equal") {
      throw new InvalidClaimError(
        `${label}.expected is the literal ${describe(literal)}, which the word "${statement.words}" fixes, and ${label}.compare is ${describe(compare)}. A value a word fixes is compared with equal alone: another compare against it holds for nearly anything, and the word does not show it`,
      );
    }
    return;
  }
  throw new InvalidClaimError(`${label}.expected must have exactly one of from, literal, observe; got ${describe(keys)}`);
}

function checkComparison(label: string, claim: Record<string, unknown>, shape: ClaimStepShape, where: Where, actualFromObserve: boolean): void {
  if (claim.each !== undefined) {
    throw new InvalidClaimError(`${label} has each, which a claim inside each cannot have`);
  }
  checkPath(`${label}.actual`, claim.actual, where === "item");
  checkCommon(label, claim);
  if (!(CLAIM_COMPARES as readonly unknown[]).includes(claim.compare)) {
    throw new InvalidClaimError(`${label}.compare must be one of ${CLAIM_COMPARES.join(", ")}; got ${describe(claim.compare)}`);
  }
  checkExpected(label, claim.expected, claim.compare, shape, actualFromObserve);
  checkExpectedView(label, claim, shape);
}

/** Whether a top-level claim's `actual` reads observe: its first segment
 * is not a `from` key. */
export function actualReadsObserve(actual: string, fromKeys: ReadonlySet<string>): boolean {
  return !fromKeys.has(pathSegments(actual)?.[0] ?? "");
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
    checkCommon(label, claim);
    const each = claim.each as Record<string, unknown> | null;
    if (typeof each !== "object" || each === null || !Array.isArray(each.claims) || each.claims.length === 0) {
      throw new InvalidClaimError(`${label}.each.claims must be a non-empty array of claims on one item`);
    }
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
    // A where claim that reads what an item claim reads selects the
    // items by the value the item claim then judges: "every item that is
    // done is done", or "every item with more than 2 has at least 2". So
    // "every item" would read as "every item that holds".
    ((each.where ?? []) as Record<string, unknown>[]).forEach((entry, whereIndex) => {
      const place = itemPath(entry);
      const same = (each.claims as Record<string, unknown>[]).findIndex((item) => samePath(itemPath(item), place));
      if (same !== -1) {
        throw new InvalidClaimError(
          `${label}.each.where[${whereIndex}] and ${label}.each.claims[${same}] both read ${describeItemPath(place)}, so where selects the items by the value the claim then judges and "every item" says nothing. Select by another value, or drop where`,
        );
      }
    });
  });
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

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
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
  return `${actual}${view}${at} ${claim.compare} ${describeExpected(claim.expected)}${expectedView}`;
}

/** A declared claim as one line: `result.exit_code equal code`, with a
 * `from`, `observe`, or JSON literal expected value named as such. Pure. */
export function describeClaim(claim: Claim): string {
  if (!isEachClaim(claim)) return describeComparison(claim, claim.actual);
  const view = claim.view === undefined ? "" : ` as ${claim.view}`;
  const at = claim.at === undefined ? "" : ` at ${claim.at}`;
  const item = (entry: ItemClaim): string => describeComparison(entry, entry.actual ?? "item");
  const where = claim.each.where === undefined ? "" : ` where ${claim.each.where.map(item).join(" and ")}`;
  return `each of ${claim.actual}${view}${at}${where}: ${claim.each.claims.map(item).join(" and ")}`;
}
