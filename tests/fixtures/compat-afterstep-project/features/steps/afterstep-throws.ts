import { AfterStep } from "../../nukadoko-compat-shim.js";

// Tagged so it applies only to a scenario that opts in. Every existing
// scenario in this project keeps the same AfterStep entry count it always
// had. Proves the non-breaking failure handling AfterStep's own header
// documents: a sibling AfterStep hook still runs after this one throws,
// the step it followed keeps its own "passed" status, and only the rest of
// the scenario is skipped.
AfterStep({ tags: "@afterstep-throws" }, function () {
  throw new Error("afterstep hook exploded on purpose");
});
