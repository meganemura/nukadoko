import { When } from "../../nukadoko-compat-shim.js";

// A compat step, on purpose: its step record always freezes `result: null`
// (docs/spec.md "Records"), which is what tests/signoff-rot.test.ts uses to
// prove the (d) returns-schema check skips a compat step record rather than
// trying to validate `null` against a schema that doesn't exist for it.
When("a legacy discount is applied", function () {
  return {};
});
