// Responsibility: the one definition of the form a value takes once it is
// stored in a record (docs/spec.md "Records"). Records are JSON, so this is
// what JSON.stringify writes and JSON.parse reads back, with one addition:
// a bigint becomes its decimal string, because JSON has no bigint and
// JSON.stringify throws on one. Redaction, harvest's read-back comparison,
// and tend's frozen-result check all work on this form, so it is defined
// once.
//
// A leaf: secrets sits below records in the layer order and redacts this
// form, so the definition cannot live in the record module.

function storeBigint(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** The value as a record stores it: toJSON applied, a bigint as its decimal
 * string, and whatever JSON drops (undefined, a function) dropped. Returns
 * undefined when nothing would be stored. Throws what JSON.stringify throws,
 * such as a toJSON that throws or a cycle. */
export function toStoredForm(value: unknown): unknown {
  const text = JSON.stringify(value, storeBigint);
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}
