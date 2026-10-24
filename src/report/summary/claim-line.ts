import type { ClaimComparisonRecord, ClaimEachRecord } from "../../record/types.js";

// Responsibility: one claim record as one line of plain text, the words
// every reader of a claim sees (docs/spec.md "Claims"): the run summary,
// the step's failure message, the Allure step that carries the claim, and
// the cucumber-messages exception. One function, so the four never
// describe the same claim differently. It reads a record that is already
// written; it does not judge anything.

/** A value longer than this is cut in a line; the record keeps it whole. */
const VALUE_TEXT_LIMIT = 120;

function valueText(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "bigint" ? `${value}n` : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > VALUE_TEXT_LIMIT ? `${text.slice(0, VALUE_TEXT_LIMIT)}...` : text;
}

function hasKey(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

function shaping(record: { readonly view?: string; readonly at?: string }): string {
  return `${record.view === undefined ? "" : ` as ${record.view}`}${record.at === undefined ? "" : ` at ${record.at}`}`;
}

/** `<actual> (<actual_from>) <compare> <expected> (<expected_from>)`, with
 * a side the record holds no value for named by its source alone. */
function comparisonText(record: ClaimComparisonRecord): string {
  const actual = hasKey(record, "actual")
    ? `${valueText(record.actual)} (${record.actual_from}${shaping(record)})`
    : `${record.actual_from}${shaping(record)}`;
  const expected = hasKey(record, "expected") ? `${valueText(record.expected)} (${record.expected_from})` : record.expected_from;
  return `${actual} ${record.compare} ${expected}`;
}

function eachText(record: ClaimEachRecord): string {
  const selected = record.each.selected === record.each.items ? "" : `, ${record.each.selected} selected`;
  return `each of ${record.actual_from}${shaping(record)} (${record.each.items} items${selected})`;
}

function isEach(record: ClaimComparisonRecord | ClaimEachRecord): record is ClaimEachRecord {
  return hasKey(record, "each");
}

/** The claim alone, without its outcome. Pure. */
export function claimText(record: ClaimComparisonRecord | ClaimEachRecord): string {
  return isEach(record) ? eachText(record) : comparisonText(record);
}

function reasonText(record: ClaimComparisonRecord | ClaimEachRecord): string {
  return record.reason === undefined ? "" : `: ${record.reason}`;
}

/** The claim and its outcome on one line, with the reason a broken claim
 * gives when it has one. Pure. */
export function claimLine(record: ClaimComparisonRecord | ClaimEachRecord): string {
  return `${claimText(record)} ${record.outcome}${reasonText(record)}`;
}

/** The first item claims of a broken `each` that did not hold, one line
 * each, so a failure names the item and the comparison. */
function brokenItemLines(record: ClaimEachRecord): string[] {
  const item = record.each.results.find((entry) => entry.outcome === "broken");
  if (item === undefined) return [];
  return item.claims.filter((claim) => claim.outcome === "broken").map((claim) => `  item ${item.index}: ${claimLine(claim)}`);
}

/** The failure message of a claim step whose claims did not all hold: one
 * line per broken claim, the first line naming the first one. Pure. */
export function brokenClaimsMessage(records: readonly (ClaimComparisonRecord | ClaimEachRecord)[]): string {
  return records
    .filter((record) => record.outcome === "broken")
    .flatMap((record) => [`claim broken: ${claimText(record)}${reasonText(record)}`, ...(isEach(record) ? brokenItemLines(record) : [])])
    .join("\n");
}
