import { Given } from "../../nukadoko-compat-shim.js";

// A RegExp pattern matching the exact same pickle text as ambiguous-typed.ts
// ("an ambiguous thing happens") — an ambiguous match across kind.
// Deliberately a RegExp, not the identical string
// pattern: two *string* patterns with identical text would also collide as
// duplicate-pattern (a separate, whole-vocabulary static check unrelated to
// any feature file), which would conflate this fixture's two independent
// check items. A RegExp pattern's duplicate-detection lives in its own
// namespace (src/check/binding-check.ts), so this isolates "ambiguous at a
// given pickle line" from "duplicate pattern text" cleanly.
Given(/^an ambiguous thing happens$/, function () {
  return {};
});
