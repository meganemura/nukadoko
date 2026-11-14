import { After } from "../../nukadoko-compat-shim.js";

// Tagged so it applies only to a scenario that opts in. Every other
// scenario in this project keeps its own untagged After hook (features/
// steps/hooks.ts) unaffected. Proves an After hook's own failure never
// takes the scenario record down with it: teardown still finishes, and
// the record itself still gets written, failed.
After({ tags: "@after-hook-throws" }, function () {
  throw new Error("after hook exploded on purpose");
});
