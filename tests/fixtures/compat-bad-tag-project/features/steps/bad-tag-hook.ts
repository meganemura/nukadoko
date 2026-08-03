import { Before } from "../../nukadoko-compat-shim.js";

// v1 supports only a single `@tag` or `not @tag` (src/compat/tag-
// expression.ts) — "and"/"or"/parentheses are Cucumber tag expression
// grammar this slice deliberately does not implement (m2b-compat-execution
// task spec, item 5: any other expression must fail at setup time with an
// explicit "unsupported" error).
Before({ tags: "@a and @b" }, function () {
  // Never reached: this is a setup-time validation failure.
});
