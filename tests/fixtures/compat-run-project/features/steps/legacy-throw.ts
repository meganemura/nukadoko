import { When } from "../../nukadoko-compat-shim.js";

// A compat step whose glue function throws (this task's spec: "fn throw で
// failed + 後続 skip").
When("a legacy step blows up", function () {
  throw new Error("legacy failure on purpose");
});
