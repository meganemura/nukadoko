import { describeRange } from "../../execution-events/count.js";
import { describeCounted, describeLeftOut } from "../../execution-events/counted.js";
import type { ClaimCompare, ClaimComparisonRecord, ClaimEachRecord, ClaimItemDeclaration, ClaimItemRecord } from "../../record/types.js";
import { snapshotDifference, snapshotExcerpt } from "../../step/aria-snapshot.js";
import { deepEqual, fieldMisfit, textFit, type StandInReading } from "../../step/evaluate-claims.js";

// Responsibility: one claim record as one line of plain text, the words
// every reader of a claim sees (docs/spec.md "Claims"): the run summary,
// the step's failure message, the Allure step that carries the claim, and
// the cucumber-messages exception. One function, so the four never
// describe the same claim differently. It reads a record that is already
// written; it does not judge anything. Where it names the place two values
// part under a compare that matches by shape (has-fields, fits-text,
// fits-aria-snapshot), it asks the matcher the claim was judged with, so
// the line cannot name a place the judging did not, and where it names the
// items two lists do not share, it pairs them with the equality the
// compare judged with.

/** A value longer than this is cut in a line; the record keeps it whole. */
const VALUE_TEXT_LIMIT = 120;

function valueText(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > VALUE_TEXT_LIMIT ? `${text.slice(0, VALUE_TEXT_LIMIT)}...` : text;
}

function hasKey(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

function expectedText(record: { readonly expected?: unknown; readonly expected_from: string }): string {
  return hasKey(record, "expected") ? `${valueText(record.expected)} (${record.expected_from})` : record.expected_from;
}

/** `<actual> (<actual_from>) <compare> <expected> (<expected_from>)`, with
 * a side the record holds no value for named by its source alone, and a
 * count of execution events that is not one number by its range. A
 * source label already names its `view` and `at`. */
function comparisonText(record: ClaimComparisonRecord): string {
  const actual = hasKey(record, "actual")
    ? (snapshotExcerptText(record) ?? `${valueText(record.actual)} (${record.actual_from})`)
    : record.actual_range !== undefined
      ? `${describeRange(record.actual_range)} (${record.actual_from})`
      : record.actual_from;
  return `${actual} ${record.compare} ${expectedText(record)}`;
}

/** The actual side of a broken `fits-aria-snapshot` claim as the lines
 * the misfit points at, with their numbers, since a page's snapshot is
 * longer than the line shows and its first lines are seldom where the two
 * part; `null` for any other claim, which shows the value's start. */
function snapshotExcerptText(record: ClaimComparisonRecord): string | null {
  if (record.compare !== "fits-aria-snapshot" || record.outcome !== "broken" || record.reason !== undefined) return null;
  if (typeof record.actual !== "string" || typeof record.expected !== "string") return null;
  const excerpt = snapshotExcerpt(record.actual, record.expected);
  if (excerpt === null) return null;
  const lines = excerpt.first === excerpt.last ? `line ${excerpt.first}` : `lines ${excerpt.first} to ${excerpt.last}`;
  return `${JSON.stringify(excerpt.text)} (${lines} of ${record.actual_from})`;
}

/** An item claim as declared: the path inside the item (counted, when the
 * claim counts), the compare, and the expected value with its source. */
function itemDeclarationText(entry: ClaimItemDeclaration): string {
  const actual = `${entry.count === true ? "count of " : ""}${entry.actual ?? "item"}${entry.view === undefined ? "" : ` as ${entry.view}`}${entry.at === undefined ? "" : ` at ${entry.at}`}`;
  return `${actual} ${entry.compare} ${expectedText(entry)}`;
}

function eachText(record: ClaimEachRecord): string {
  const selected = record.each.selected === record.each.items ? "" : `, ${record.each.selected} selected`;
  const where = record.each.where === undefined ? "" : ` where ${record.each.where.map(itemDeclarationText).join(" and ")}`;
  return `each of ${record.actual_from} (${itemCount(record.each.items)}${selected})${where}: ${record.each.claims.map(itemDeclarationText).join(" and ")}`;
}

function isEach(record: ClaimComparisonRecord | ClaimEachRecord): record is ClaimEachRecord {
  return hasKey(record, "each");
}

/** The claim alone, without its outcome. Pure. */
export function claimText(record: ClaimComparisonRecord | ClaimEachRecord): string {
  return isEach(record) ? eachText(record) : comparisonText(record);
}

/** Characters shown on each side of a text's first difference. */
const DIFFERENCE_CONTEXT = 20;

/** Where two JSON values first differ: a path of keys and indexes, and
 * what each side holds there, `undefined` for a side that has nothing. */
interface Difference {
  readonly path: readonly string[];
  readonly actual: unknown;
  readonly expected: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b) && typeof a === typeof b;
}

function differenceIn(actual: unknown, expected: unknown, path: readonly string[]): Difference | null {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
      const found = differenceIn(actual[index], expected[index], [...path, String(index)]);
      if (found !== null) return found;
    }
    return null;
  }
  if (isPlainObject(actual) && isPlainObject(expected)) {
    const keys = [...Object.keys(actual), ...Object.keys(expected).filter((key) => !Object.hasOwn(actual, key))];
    for (const key of keys) {
      const found = differenceIn(
        Object.hasOwn(actual, key) ? actual[key] : undefined,
        Object.hasOwn(expected, key) ? expected[key] : undefined,
        [...path, key],
      );
      if (found !== null) return found;
    }
    return null;
  }
  return sameJson(actual, expected) ? null : { path, actual, expected };
}

function sideText(value: unknown): string {
  return value === undefined ? "nothing" : valueText(value);
}

/** Where two texts first differ: by line when either has more than one,
 * by character otherwise, with a little of each side around it. */
function textDifference(actual: string, expected: string): string {
  if (actual.includes("\n") || expected.includes("\n")) {
    const actualLines = actual.split("\n");
    const expectedLines = expected.split("\n");
    let line = 0;
    while (actualLines[line] === expectedLines[line]) line += 1;
    return `line ${line + 1}: actual ${sideText(actualLines[line])}, expected ${sideText(expectedLines[line])}`;
  }
  // Counted in code points, so the position is the character a reader
  // counts and the window never splits a character outside the BMP.
  const actualPoints = Array.from(actual);
  const expectedPoints = Array.from(expected);
  let at = 0;
  while (at < actualPoints.length && actualPoints[at] === expectedPoints[at]) at += 1;
  const start = Math.max(0, at - DIFFERENCE_CONTEXT);
  const around = (points: readonly string[]): string =>
    `${start > 0 ? "..." : ""}${points.slice(start, at + DIFFERENCE_CONTEXT).join("")}${points.length > at + DIFFERENCE_CONTEXT ? "..." : ""}`;
  return `character ${at + 1}: actual ${JSON.stringify(around(actualPoints))}, expected ${JSON.stringify(around(expectedPoints))}`;
}

/** Where a broken `equal` claim's two values first differ, for a text
 * too long to read whole in the line or with more than one line, and for
 * two arrays or two objects, or for two lists with an item inserted or
 * removed, the items they do not share in order; `null` otherwise, when
 * both values in the line already show the difference. Pure. */
export function equalDifference(actual: unknown, expected: unknown): string | null {
  if (typeof actual === "string" && typeof expected === "string") {
    if (actual === expected) return null;
    const long = JSON.stringify(actual).length > VALUE_TEXT_LIMIT || JSON.stringify(expected).length > VALUE_TEXT_LIMIT;
    return long || actual.includes("\n") || expected.includes("\n") ? `first difference at ${textDifference(actual, expected)}` : null;
  }
  const containers = (Array.isArray(actual) && Array.isArray(expected)) || (isPlainObject(actual) && isPlainObject(expected));
  if (!containers) return null;
  const found = differenceIn(actual, expected, []);
  if (found === null) return null;
  const first = `first difference at ${differenceAt(found.path, found.actual, found.expected)}`;
  return Array.isArray(actual) && Array.isArray(expected) ? listDifference(actual, expected, first) : first;
}

/** A path and what each side holds there, with the line or character
 * where two texts differ when the values alone would not show it. */
function differenceAt(path: readonly string[], actual: unknown, expected: unknown): string {
  if (typeof actual === "string" && typeof expected === "string" && equalDifference(actual, expected) !== null) {
    return `${path.join(".")}, ${textDifference(actual, expected)}`;
  }
  return `${path.join(".")}: actual ${sideText(actual)}, expected ${sideText(expected)}`;
}

function itemCount(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

/** The first expected field a broken `has-fields` claim's actual object
 * lacks or holds another value at, found by the matcher the claim was
 * judged with; `null` when the two fit. Pure. */
export function fieldsDifference(actual: unknown, expected: unknown): string | null {
  const misfit = fieldMisfit(actual, expected);
  if (misfit === null) return null;
  const at = misfit.path.join(".");
  switch (misfit.kind) {
    case "missing":
      return `first field that does not fit at ${at}: actual nothing, expected ${valueText(misfit.expected)}`;
    case "length":
      return `first field that does not fit at ${at}: actual ${itemCount(misfit.actual)}, expected ${itemCount(misfit.expected)}`;
    case "differs":
      return `first field that does not fit at ${differenceAt(misfit.path, misfit.actual, misfit.expected)}`;
  }
}

/** How far a broken `fits-text` claim's expected text fit, and the first
 * expected line that fits nothing after that, with the actual line where
 * it stopped, or, when every line fits, the two named stand-ins that broke
 * it, with what each read and where. Found by the matcher the claim was
 * judged with; `null` when the two fit, or for a value that is not a
 * text. Pure. */
export function fitsDifference(actual: unknown, expected: unknown): string | null {
  if (typeof actual !== "string" || typeof expected !== "string") return null;
  const fit = textFit(actual, expected);
  if (fit.fits) return null;
  if ("readings" in fit) return readingsDifference(...fit.readings);
  if (fit.expected === undefined) return `every expected line fits, and actual line ${fit.at} is left over: actual ${sideText(fit.actual)}`;
  const fitted = fit.fitted === 0 ? "" : fit.fitted === 1 ? "expected line 1 fits, and " : `expected lines 1 to ${fit.fitted} fit, and `;
  return `${fitted}expected line ${fit.fitted + 1} fits nothing from actual line ${fit.at}: actual ${sideText(fit.actual)}, expected ${valueText(fit.expected)}`;
}

/** Two readings of named stand-ins that break a text whose lines fit:
 * one name that read two texts, or two names that read one. */
function readingsDifference(first: StandInReading, then: StandInReading): string {
  const where =
    first.at === then.at
      ? `in actual line ${first.at}: actual ${valueText(first.line)}`
      : `in actual lines ${first.at} and ${then.at}: actual ${valueText(first.line)}, then ${valueText(then.line)}`;
  const read =
    first.name === then.name
      ? `[..:${first.name}] reads ${valueText(first.text)} and then ${valueText(then.text)}`
      : `[..:${first.name}] and [..:${then.name}] both read ${valueText(first.text)}`;
  return `every expected line fits, but ${read} ${where}`;
}

/** The first expected line of a broken `fits-aria-snapshot` claim that
 * fits nothing, the actual node it was looked for under, and the nearest
 * actual node, found by the matcher the claim was judged with; `null`
 * when the two fit, or for a value that is not a text. Pure. */
export function ariaSnapshotDifferenceOf(actual: unknown, expected: unknown): string | null {
  return typeof actual === "string" && typeof expected === "string" ? snapshotDifference(actual, expected) : null;
}

/** The field a broken `lacks-field` claim's actual object holds, with its
 * value, since an object too long for the line may not show it, and a
 * field set to `null` reads as absent to a reader who expects it gone;
 * `null` when the object lacks it. Pure. */
export function presentFieldDifference(actual: unknown, expected: unknown): string | null {
  if (!isPlainObject(actual) || typeof expected !== "string" || !Object.hasOwn(actual, expected)) return null;
  return `field ${JSON.stringify(expected)} is present and holds ${valueText(actual[expected])}`;
}

/** The pairs of items a line may compare to name the items two lists do
 * not share, past the items equal in place at their start and their end;
 * past it, the line says what it says without them. Comparing 250,000
 * pairs of rows of four fields took about 30 ms, and a line is written
 * once for each surface that shows it. */
const ITEM_PAIRS_LIMIT = 250_000;

/** The items a line shows of each list it names, before it counts the
 * rest. */
const LISTED_ITEMS = 3;

/** The items two lists do not share, by index: `missing` indexes the
 * expected list, and `extra` the actual list. */
export interface UnsharedItems {
  readonly missing: readonly number[];
  readonly extra: readonly number[];
}

function indexesFrom(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}

/** How many items at the start of two lists are equal in place, and
 * then how many at their end, so the work of pairing the rest grows with
 * the part where the two differ, not with their length. */
function sharedEnds(actual: readonly unknown[], expected: readonly unknown[]): { readonly start: number; readonly end: number } {
  const shorter = Math.min(actual.length, expected.length);
  let start = 0;
  while (start < shorter && deepEqual(actual[start], expected[start])) start += 1;
  let end = 0;
  while (end < shorter - start && deepEqual(actual[actual.length - 1 - end], expected[expected.length - 1 - end])) end += 1;
  return { start, end };
}

/** The items of two lists that pair with no equal item on the other
 * side, a duplicate needing an item of its own, as `has-same-items`
 * pairs them; `null` past `ITEM_PAIRS_LIMIT`. Pure. */
export function unpairedItems(actual: readonly unknown[], expected: readonly unknown[]): UnsharedItems | null {
  const { start, end } = sharedEnds(actual, expected);
  const actualEnd = actual.length - end;
  const expectedEnd = expected.length - end;
  if ((actualEnd - start) * (expectedEnd - start) > ITEM_PAIRS_LIMIT) return null;
  const missing = indexesFrom(start, expectedEnd);
  const extra: number[] = [];
  for (let index = start; index < actualEnd; index += 1) {
    const at = missing.findIndex((other) => deepEqual(actual[index], expected[other]));
    if (at === -1) extra.push(index);
    else missing.splice(at, 1);
  }
  return { missing, extra };
}

/** The items two lists do not share in order. Each `changed` pair is an
 * actual item and the expected item that stands in its place: between
 * the same two shared items, in a stretch with as many items on each
 * side. */
export interface AlignedItems extends UnsharedItems {
  readonly changed: readonly { readonly actual: number; readonly expected: number }[];
}

/** The items of two lists that a longest run of equal items, in order,
 * leaves out, so an item inserted into a list is one extra item and not
 * a change to every item after it; `null` past `ITEM_PAIRS_LIMIT`.
 * Items are equal as `equal` judges them. Pure. */
export function alignedItems(actual: readonly unknown[], expected: readonly unknown[]): AlignedItems | null {
  const { start, end } = sharedEnds(actual, expected);
  const actualCount = actual.length - end - start;
  const expectedCount = expected.length - end - start;
  if (actualCount * expectedCount > ITEM_PAIRS_LIMIT) return null;
  const same = (a: number, e: number) => deepEqual(actual[start + a], expected[start + e]);
  // longest[a * width + e]: how many items, in order, the actual items
  // from a and the expected items from e share at most.
  const width = expectedCount + 1;
  const longest = new Uint32Array((actualCount + 1) * width);
  const at = (a: number, e: number) => longest[a * width + e] ?? 0;
  for (let a = actualCount - 1; a >= 0; a -= 1) {
    for (let e = expectedCount - 1; e >= 0; e -= 1) longest[a * width + e] = same(a, e) ? at(a + 1, e + 1) + 1 : Math.max(at(a + 1, e), at(a, e + 1));
  }
  const missing: number[] = [];
  const extra: number[] = [];
  const changed: { actual: number; expected: number }[] = [];
  let stretch: { actual: number[]; expected: number[] } = { actual: [], expected: [] };
  const closeStretch = () => {
    if (stretch.actual.length === stretch.expected.length) {
      for (const [offset, index] of stretch.actual.entries()) changed.push({ actual: index, expected: stretch.expected[offset]! });
    } else {
      missing.push(...stretch.expected);
      extra.push(...stretch.actual);
    }
    stretch = { actual: [], expected: [] };
  };
  let a = 0;
  let e = 0;
  while (a < actualCount || e < expectedCount) {
    if (a < actualCount && e < expectedCount && same(a, e)) {
      closeStretch();
      a += 1;
      e += 1;
    } else if (e < expectedCount && (a === actualCount || at(a + 1, e) <= at(a, e + 1))) {
      stretch.expected.push(start + e);
      e += 1;
    } else {
      stretch.actual.push(start + a);
      a += 1;
    }
  }
  closeStretch();
  return { missing, extra, changed };
}

/** `<value> (item <index>)` for the first few items, then how many more. */
function listedItems(indexes: readonly number[], items: readonly unknown[]): string {
  const shown = indexes.slice(0, LISTED_ITEMS).map((index) => `${valueText(items[index])} (item ${index})`);
  const more = indexes.length - shown.length;
  return more === 0 ? shown.join(", ") : `${shown.join(", ")}, and ${more} more`;
}

function unsharedText(unshared: UnsharedItems, actual: readonly unknown[], expected: readonly unknown[]): string | null {
  const head = (indexes: readonly number[], side: string) => `${indexes.length} ${side} ${indexes.length === 1 ? "item is" : "items are"}`;
  const parts = [
    ...(unshared.missing.length === 0 ? [] : [`${head(unshared.missing, "expected")} missing: ${listedItems(unshared.missing, expected)}`]),
    ...(unshared.extra.length === 0 ? [] : [`${head(unshared.extra, "actual")} extra: ${listedItems(unshared.extra, actual)}`]),
  ];
  return parts.length === 0 ? null : parts.join("; ");
}

/** The first changed item, by its actual index and, when another, its
 * expected one, and where it first differs: `item 1 changed at 2: actual
 * "3", expected "1"`, or with the count first when more items changed. */
function changedText(changed: AlignedItems["changed"], actual: readonly unknown[], expected: readonly unknown[]): string | null {
  const first = changed[0];
  if (first === undefined) return null;
  const found = differenceIn(actual[first.actual], expected[first.expected], []);
  if (found === null) return null;
  const item = first.actual === first.expected ? `item ${first.actual}` : `item ${first.actual} (expected item ${first.expected})`;
  const where = `${found.path.length === 0 ? "" : " at "}${differenceAt(found.path, found.actual, found.expected)}`;
  return changed.length === 1 ? `${item} changed${where}` : `${changed.length} items changed, first ${item}${where}`;
}

/** Where a broken `equal` claim's two lists part, given the first
 * difference by place. A list with an item inserted or removed names the
 * items the two do not share in order, since every item after it would
 * differ by place. Two lists that differ only in items changed in place
 * keep the first difference, which names the field, and two lists that
 * hold the same items say so before it. */
function listDifference(actual: readonly unknown[], expected: readonly unknown[], first: string): string {
  const unpaired = unpairedItems(actual, expected);
  if (unpaired !== null && unpaired.missing.length === 0 && unpaired.extra.length === 0) return `the same items in another order, ${first}`;
  const aligned = alignedItems(actual, expected);
  if (aligned === null || (aligned.missing.length === 0 && aligned.extra.length === 0)) return first;
  return [unsharedText(aligned, actual, expected), changedText(aligned.changed, actual, expected)].filter((part) => part !== null).join("; ");
}

/** The items a broken `has-same-items` claim's two lists do not share:
 * the expected items no actual item pairs with, and the actual items no
 * expected item pairs with, each with its index and its value; `null`
 * when they share every item, or past `ITEM_PAIRS_LIMIT`. Pure. */
export function sameItemsDifference(actual: unknown, expected: unknown): string | null {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return null;
  const unpaired = unpairedItems(actual, expected);
  return unpaired === null ? null : unsharedText(unpaired, actual, expected);
}

/** What a broken claim's line adds after its outcome, by compare: where
 * the two values part. A compare with no row adds nothing, since the two
 * values in the line already show why it broke. */
const DIFFERENCES: Partial<Record<ClaimCompare, (actual: unknown, expected: unknown) => string | null>> = {
  equal: equalDifference,
  "has-same-items": sameItemsDifference,
  "has-fields": fieldsDifference,
  "lacks-field": presentFieldDifference,
  "fits-text": fitsDifference,
  "fits-aria-snapshot": ariaSnapshotDifferenceOf,
};

function differenceText(record: ClaimComparisonRecord | ClaimEachRecord): string {
  if (isEach(record) || record.outcome !== "broken" || record.reason !== undefined) return "";
  const describe = DIFFERENCES[record.compare];
  if (describe === undefined || !hasKey(record, "actual") || !hasKey(record, "expected")) return "";
  const difference = describe(record.actual, record.expected);
  return difference === null ? "" : `; ${difference}`;
}

function reasonText(record: ClaimComparisonRecord | ClaimEachRecord): string {
  return record.reason === undefined ? differenceText(record) : `: ${record.reason}`;
}

/** What a count of execution events counted, after its outcome and its
 * reason, under every outcome: a count that held on the wrong table reads
 * as plainly as one that broke on it. Then what it left out, since the
 * program marks their table: a count that held only because it left a
 * line out says which line and why. */
function countedText(record: ClaimComparisonRecord | ClaimEachRecord): string {
  if (isEach(record)) return "";
  const counted = record.counted === undefined ? "" : describeCounted(record.counted);
  const leftOut = record.left_out === undefined ? "" : describeLeftOut(record.left_out);
  return `${counted === "" ? "" : `; counted ${counted}`}${leftOut === "" ? "" : `; left out ${leftOut}`}`;
}

/** The outcome of the item an `each` line names. */
const namedOutcome = (record: ClaimEachRecord): "broken" | "unjudged" => (record.outcome === "unjudged" ? "unjudged" : "broken");

/** The first selected item of a broken `each` whose claims did not hold,
 * or of an `each` nukadoko could not judge, the first selected item it
 * could not judge: without it, such a line would say `unjudged` and
 * not why. */
function namedItem(record: ClaimEachRecord): Extract<ClaimItemRecord, { selected: true }> | undefined {
  const outcome = namedOutcome(record);
  const item = record.each.results.find((entry) => entry.selected && entry.outcome === outcome);
  return item === undefined || !item.selected ? undefined : item;
}

/** An item claim as an `each` line names it: what it compared, and why
 * nukadoko could not judge it, when it could not. */
function itemClaimText(claim: ClaimComparisonRecord): string {
  return claim.outcome === "unjudged" && claim.reason !== undefined ? `${comparisonText(claim)}: ${claim.reason}` : comparisonText(claim);
}

/** `item 3`, or `item 3 (name "Beta")` when the item has a field that
 * names it. */
function itemName(item: Extract<ClaimItemRecord, { selected: true }>): string {
  return item.identity === undefined ? `item ${item.index}` : `item ${item.index} (${item.identity.field} ${valueText(item.identity.value)})`;
}

/** The claim and its outcome on one line, with the reason a broken claim
 * gives when it has one. A broken `each` names its first broken item and
 * that item's first broken comparison, since the declaration alone states
 * the expected value and not what the item held, and an `each` nukadoko
 * could not judge names its first such item and comparison, and why. Pure. */
export function claimLine(record: ClaimComparisonRecord | ClaimEachRecord): string {
  const line = `${claimText(record)} ${record.outcome}${reasonText(record)}${countedText(record)}`;
  if (!isEach(record)) return line;
  const item = namedItem(record);
  const claim = item?.claims.find((entry) => entry.outcome === namedOutcome(record));
  return item === undefined || claim === undefined ? line : `${line}; ${itemName(item)}: ${itemClaimText(claim)}`;
}

/** The item `claimLine` names of an `each` that did not hold, one line
 * per claim of it that broke or that nukadoko could not judge, so a
 * failure names the item and the comparison. */
function namedItemLines(record: ClaimEachRecord): string[] {
  const item = namedItem(record);
  if (item === undefined) return [];
  return item.claims.filter((claim) => claim.outcome === namedOutcome(record)).map((claim) => `  ${itemName(item)}: ${claimLine(claim)}`);
}

/** The failure message of a claim step whose claims did not all hold: one
 * line per claim that broke or that nukadoko could not judge, the first
 * line naming the first one. Pure. */
export function brokenClaimsMessage(records: readonly (ClaimComparisonRecord | ClaimEachRecord)[]): string {
  return records
    .filter((record) => record.outcome === "broken" || record.outcome === "unjudged")
    .flatMap((record) => [
      `claim ${record.outcome}: ${claimText(record)}${reasonText(record)}${countedText(record)}`,
      ...(isEach(record) ? namedItemLines(record) : []),
    ])
    .join("\n");
}
