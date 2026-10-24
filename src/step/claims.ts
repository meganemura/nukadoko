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

// Thrown inside this module only: the first problem found ends the check,
// and the exported functions return its message.
class InvalidClaimError extends Error {}

// --- the literal rule ---
//
// A literal is the one expected value that is in neither the sentence's
// data nor an earlier step's result, so it would let step code carry the
// criterion again ("the command succeeds" claiming 0). It is allowed only
// when the sentence itself states it: its text is a run of the pattern's
// fixed words, or it is the fixed value of a fixed word in the table
// below. A word inside a capture, an optional group, or an alternation is
// not fixed, because the sentence a line binds may not say it.

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

/** The text a literal states in a sentence, as words; `null` for a value
 * no word can state. */
function literalWords(literal: unknown): readonly string[] | null {
  if (typeof literal === "string") {
    return literal.split(/\s+/).map(normalizedWord).filter((word) => word.length > 0);
  }
  if (typeof literal === "number" && Number.isFinite(literal)) return [String(literal)];
  if (typeof literal === "boolean" || literal === null) return [String(literal)];
  return null;
}

function sameLiteral(a: unknown, b: ClaimLiteral): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === 0 && b.length === 0;
  return Object.is(a, b);
}

function containsRun(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0) return false;
  for (let start = 0; start + run.length <= words.length; start += 1) {
    if (run.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

/** The pattern words that state `literal`, as the record names them
 * (`literal:<words>`), or `null` when `pattern` does not state it. Pure. */
export function literalStatedBy(pattern: string, literal: unknown): string | null {
  const words = fixedWords(pattern);
  const own = literalWords(literal);
  if (own !== null && containsRun(words, own)) return own.join(" ");
  for (const word of words) {
    const values = LITERAL_WORDS[word.toLowerCase()];
    if (values?.some((value) => sameLiteral(literal, value))) return word;
  }
  return null;
}

/** The words that state `literal` in every pattern, or `null` when one
 * pattern does not: a line may bind any of them. The first pattern's words
 * name it. */
export function literalStatedByAll(patterns: readonly string[], literal: unknown): string | null {
  if (patterns.length === 0) return null;
  const stated = patterns.map((pattern) => literalStatedBy(pattern, literal));
  return stated.every((words) => words !== null) ? stated[0]! : null;
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

function checkExpected(label: string, expected: unknown, shape: ClaimStepShape, actualFromObserve: boolean): void {
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
    if (literalWords(literal) === null && !(Array.isArray(literal) && literal.length === 0)) {
      throw new InvalidClaimError(
        `${label}.expected.literal must be a string, a finite number, a boolean, null, or []; got ${describe(literal)}`,
      );
    }
    if (typeof literal === "boolean" && actualFromObserve) {
      throw new InvalidClaimError(
        `${label}.expected is the boolean ${String(literal)}, and its actual comes from observe. A boolean computed by observe is a judgment made in code: return the thing measured (a count, a text, a list) and let the claim compare it`,
      );
    }
    if (literalStatedByAll(shape.patterns, literal) === null) {
      const where =
        shape.patterns.length === 0
          ? "the step has no pattern, so no sentence states it"
          : `no fixed word of ${shape.patterns.map((pattern) => `"${pattern}"`).join(" and ")} states it`;
      throw new InvalidClaimError(
        `${label}.expected is the literal ${describe(literal)}, and ${where}. Put the value in the sentence, as fixed words or as a capture the claim names`,
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
  checkExpected(label, claim.expected, shape, actualFromObserve);
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
  });
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
  return `${actual}${view}${at} ${claim.compare} ${describeExpected(claim.expected)}`;
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
