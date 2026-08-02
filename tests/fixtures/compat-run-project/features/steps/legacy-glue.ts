import { Given, Then, When, defineParameterType } from "../../nukadoko-compat-shim.js";

// Custom parameter type registered from compat ("support") code (m2b-
// compat-execution task spec, item 2): proves a compat-origin
// `defineParameterType` merges into the same registry `nuka run` uses to
// match — the pattern below could not match "the legacy flag is yes"
// without it (closing m2a-compat-registry's "temporary asymmetry #2":
// `nuka check` already treated this pattern as defined; `nuka run` now
// actually matches and executes it).
defineParameterType({
  name: "legacyBoolean",
  regexp: /(yes|no)/,
  transformer: (value: string) => value === "yes",
});

// String pattern, `{string}` built-in capture (this task's spec, item 3:
// positional args, no named-capture requirement).
Given("a legacy project {string} exists", function (name: string) {
  return { name };
});

// RegExp pattern (this task's spec, item 1: string and RegExp patterns
// alike) — its capture group arrives as a plain string (RegExp semantics),
// unlike a typed step's coerced `{int}`.
When(/^a legacy request is made with (\d+) items$/, function (count: string) {
  if (Number(count) < 0) {
    throw new Error("negative item count");
  }
});

// Then-position compat step using the compat-origin parameter type above.
Then("the legacy flag is {legacyBoolean}", function (flag: boolean) {
  if (flag !== true) {
    throw new Error(`expected the legacy flag to be true, got ${flag}`);
  }
});

// Table arrives as a DataTable (2026-08-02 lead scope addendum) —
// `.hashes()` folds the header row into keys for every data row.
When("a legacy table is provided:", function (table: { hashes(): Record<string, string>[] }) {
  const rows = table.hashes();
  if (rows.length !== 2 || rows[0]?.name !== "alice" || rows[1]?.name !== "bob") {
    throw new Error(`unexpected table contents: ${JSON.stringify(rows)}`);
  }
});

// Docstring arrives as a plain string (this task's spec, item 3).
When("a legacy docstring is provided:", function (text: string) {
  if (text !== "hello docstring") {
    throw new Error(`unexpected docstring: ${text}`);
  }
});
