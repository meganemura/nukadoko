import type { ClaimComparisonRecord, ClaimEachRecord, ClaimItemDeclaration, ClaimItemRecord } from "../../record/types.js";

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

/** An item claim as declared: the path inside the item, the compare, and
 * the expected value with its source. */
function itemDeclarationText(entry: ClaimItemDeclaration): string {
  const actual = `${entry.actual ?? "item"}${entry.view === undefined ? "" : ` as ${entry.view}`}${entry.at === undefined ? "" : ` at ${entry.at}`}`;
  return `${actual} ${entry.compare} ${expectedText(entry)}`;
}

function eachText(record: ClaimEachRecord): string {
  const selected = record.each.selected === record.each.items ? "" : `, ${record.each.selected} selected`;
  const where = record.each.where === undefined ? "" : ` where ${record.each.where.map(itemDeclarationText).join(" and ")}`;
  return `each of ${record.actual_from} (${record.each.items} items${selected})${where}: ${record.each.claims.map(itemDeclarationText).join(" and ")}`;
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

/** The first selected item of a broken `each` whose claims did not hold. */
function firstBrokenItem(record: ClaimEachRecord): Extract<ClaimItemRecord, { selected: true }> | undefined {
  const item = record.each.results.find((entry) => entry.selected && entry.outcome === "broken");
  return item === undefined || !item.selected ? undefined : item;
}

/** `item 3`, or `item 3 (name "Beta")` when the item has a field that
 * names it. */
function itemName(item: Extract<ClaimItemRecord, { selected: true }>): string {
  return item.identity === undefined ? `item ${item.index}` : `item ${item.index} (${item.identity.field} ${valueText(item.identity.value)})`;
}

/** The claim and its outcome on one line, with the reason a broken claim
 * gives when it has one. A broken `each` names its first broken item and
 * that item's first broken comparison, since the declaration alone states
 * the expected value and not what the item held. Pure. */
export function claimLine(record: ClaimComparisonRecord | ClaimEachRecord): string {
  const line = `${claimText(record)} ${record.outcome}${reasonText(record)}`;
  if (!isEach(record)) return line;
  const item = firstBrokenItem(record);
  const claim = item?.claims.find((entry) => entry.outcome === "broken");
  return item === undefined || claim === undefined ? line : `${line}; ${itemName(item)}: ${comparisonText(claim)}`;
}

/** The first broken item of a broken `each`, one line per claim that
 * broke, so a failure names the item and the comparison. */
function brokenItemLines(record: ClaimEachRecord): string[] {
  const item = firstBrokenItem(record);
  if (item === undefined) return [];
  return item.claims.filter((claim) => claim.outcome === "broken").map((claim) => `  ${itemName(item)}: ${claimLine(claim)}`);
}

/** The failure message of a claim step whose claims did not all hold: one
 * line per claim that broke or that nukadoko could not judge, the first
 * line naming the first one. Pure. */
export function brokenClaimsMessage(records: readonly (ClaimComparisonRecord | ClaimEachRecord)[]): string {
  return records
    .filter((record) => record.outcome === "broken" || record.outcome === "unjudged")
    .flatMap((record) => [
      `claim ${record.outcome}: ${claimText(record)}${reasonText(record)}`,
      ...(isEach(record) ? brokenItemLines(record) : []),
    ])
    .join("\n");
}
