import { Given } from "../../nukadoko-compat-shim.js";

// `require` is CommonJS-only; calling it from this ES module throws a
// ReferenceError as soon as evaluation reaches it — before the Given() call
// below ever runs, so "a broken thing happens" is never registered
// (m21-compat-gap findings.md, Q1/Q3: gap 2, "CJS require()"). Typechecks
// cleanly even though it never actually imports under Node's ESM loader:
// `require` is declared as an ambient global by @types/node's own
// module.d.ts regardless of this file's own module kind.
// tests/discover-steps.test.ts uses this file to prove tolerant discovery
// skips exactly this file and none other.
require("node:path");

Given("a broken thing happens", function () {
  // Never reached: the require() call above fails first.
});
