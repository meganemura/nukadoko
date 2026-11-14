import { AfterStep, Before, Given } from "../../nukadoko-compat-shim.js";

// Compat code the state check cannot read: a step, and hooks that apply
// only to the scenarios their tags name.
Given("the legacy sign-in runs", function () {});
Before({ tags: "@hooked" }, function () {});
AfterStep({ tags: "@after-each" }, function () {});
