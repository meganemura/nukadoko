import { When } from "../../nukadoko-compat-shim.js";

// A compat step, on purpose: its receipt always freezes `result: null`
// (docs/spec.md "Receipts"), which is what tests/signoff-rot.test.ts uses to
// prove the (d) returns-schema check skips a compat receipt rather than
// trying to validate `null` against a schema that doesn't exist for it.
When("a legacy discount is applied", function () {
  return {};
});
