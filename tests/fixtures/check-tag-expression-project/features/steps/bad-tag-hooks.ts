import { After, Before, Given } from "../../nukadoko-compat-shim.js";

// v1 supports only a single `@tag` or `not @tag` (src/compat/tag-
// expression.ts) — "and"/"or"/parentheses are Cucumber tag expression
// grammar this slice deliberately does not implement. Two separate hooks
// violate it here, on purpose (walk every hook and report every one), so
// tests/check.test.ts can assert `nuka check` reports both
// instead of stopping at the first.
Before({ tags: "@a and @b" }, function () {
  // Never reached: this is a setup-time validation failure.
});

After({ tags: "@c or @d" }, function () {
  // Never reached: this is a setup-time validation failure.
});

Given("nothing happens", function () {
  return {};
});
