import { When } from "../../nukadoko-compat-shim.js";

// A compat step whose glue function throws (this task's spec: fn throwing
// produces a failed status and the remaining steps are skipped).
When("a legacy step blows up", function () {
  throw new Error("legacy failure on purpose");
});
