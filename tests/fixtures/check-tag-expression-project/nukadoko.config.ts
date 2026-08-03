import { defineConfig } from "./nukadoko-shim.js";

// m21a-compat-gap-detect task spec, decision 5: two hooks with an
// unsupported tag expression (Cucumber's `and`/`or`/parentheses grammar,
// v1's own subset does not implement — src/compat/tag-expression.ts) — the
// same setup failure `nuka run` already refuses to start against
// (tests/fixtures/compat-bad-tag-project), but `nuka check` must report
// every violating hook, not stop at the first.
export default defineConfig({});
