import { Given } from "../../nukadoko-compat-shim.js";

// tests/compat-discover.test.ts: "shared pattern here" is also registered by
// b-glue.ts under a different keyword — compat identity is the pattern
// source, not the keyword or the file, so this collides
// (DuplicateCompatStepError).
Given("shared pattern here", function () {
  return {};
});
