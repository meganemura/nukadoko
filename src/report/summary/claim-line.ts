import type { ClaimCompare, ClaimComparisonRecord, ClaimEachRecord, ClaimItemDeclaration, ClaimItemRecord } from "../../record/types.js";
import { fieldMisfit, textFit } from "../../step/evaluate-claims.js";

// Responsibility: one claim record as one line of plain text, the words
// every reader of a claim sees (docs/spec.md "Claims"): the run summary,
// the step's failure message, the Allure step that carries the claim, and
// the cucumber-messages exception. One function, so the four never
// describe the same claim differently. It reads a record that is already
// written; it does not judge anything. Where it names the place two values
// part under a compare that matches by shape (has-fields, fits-text), it
// asks the matcher the claim was judged with, so the line cannot name a
// place the judging did not.

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
 * a side the record holds no value for named by its source alone. A source
 * label already names its `view` and `at`. */
function comparisonText(record: ClaimComparisonRecord): string {
  const actual = hasKey(record, "actual") ? `${valueText(record.actual)} (${record.actual_from})` : record.actual_from;
  return `${actual} ${record.compare} ${expectedText(record)}`;
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
 * two arrays or two objects; `null` otherwise, when both values in the
 * line already show the difference. Pure. */
export function equalDifference(actual: unknown, expected: unknown): string | null {
  if (typeof actual === "string" && typeof expected === "string") {
    if (actual === expected) return null;
    const long = JSON.stringify(actual).length > VALUE_TEXT_LIMIT || JSON.stringify(expected).length > VALUE_TEXT_LIMIT;
    return long || actual.includes("\n") || expected.includes("\n") ? `first difference at ${textDifference(actual, expected)}` : null;
  }
  const containers = (Array.isArray(actual) && Array.isArray(expected)) || (isPlainObject(actual) && isPlainObject(expected));
  if (!containers) return null;
  const found = differenceIn(actual, expected, []);
  return found === null ? null : `first difference at ${differenceAt(found.path, found.actual, found.expected)}`;
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
 * it stopped, found by the matcher the claim was judged with; `null` when
 * the two fit, or for a value that is not a text. Pure. */
export function fitsDifference(actual: unknown, expected: unknown): string | null {
  if (typeof actual !== "string" || typeof expected !== "string") return null;
  const fit = textFit(actual, expected);
  if (fit.fits) return null;
  if (fit.expected === undefined) return `every expected line fits, and actual line ${fit.at} is left over: actual ${sideText(fit.actual)}`;
  const fitted = fit.fitted === 0 ? "" : fit.fitted === 1 ? "expected line 1 fits, and " : `expected lines 1 to ${fit.fitted} fit, and `;
  return `${fitted}expected line ${fit.fitted + 1} fits nothing from actual line ${fit.at}: actual ${sideText(fit.actual)}, expected ${valueText(fit.expected)}`;
}

/** The field a broken `lacks-field` claim's actual object holds, with its
 * value, since an object too long for the line may not show it, and a
 * field set to `null` reads as absent to a reader who expects it gone;
 * `null` when the object lacks it. Pure. */
export function presentFieldDifference(actual: unknown, expected: unknown): string | null {
  if (!isPlainObject(actual) || typeof expected !== "string" || !Object.hasOwn(actual, expected)) return null;
  return `field ${JSON.stringify(expected)} is present and holds ${valueText(actual[expected])}`;
}

/** What a broken claim's line adds after its outcome, by compare: where
 * the two values part. A compare with no row adds nothing, since the two
 * values in the line already show why it broke. */
const DIFFERENCES: Partial<Record<ClaimCompare, (actual: unknown, expected: unknown) => string | null>> = {
  equal: equalDifference,
  "has-fields": fieldsDifference,
  "lacks-field": presentFieldDifference,
  "fits-text": fitsDifference,
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
  const line = `${claimText(record)} ${record.outcome}${reasonText(record)}`;
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
      `claim ${record.outcome}: ${claimText(record)}${reasonText(record)}`,
      ...(isEach(record) ? namedItemLines(record) : []),
    ])
    .join("\n");
}
