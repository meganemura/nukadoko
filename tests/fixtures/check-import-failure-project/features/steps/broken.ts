import { Given } from "../../nukadoko-compat-shim.js";

// `require` is CommonJS-only; calling it from this ES module throws a
// ReferenceError as soon as evaluation reaches it — before the Given() call
// below ever runs, so "a broken thing happens" is never registered
// (m21-compat-gap findings.md, Q1/Q3: gap 2, "CJS require()"). Typechecks
// cleanly even though it never actually imports under Node's ESM loader:
// `require` is declared as an ambient global by @types/node's own
// module.d.ts regardless of this file's own module kind. So
// features/check.feature's own use of "a broken thing happens" is undefined
// at check time unless suppressed.
require("node:path");

Given("a broken thing happens", function () {
  // Never reached: the require() call above fails first.
});
