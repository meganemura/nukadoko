import { Given } from "../../nukadoko-compat-shim.js";

// Imports successfully right after a-partial-eval-failure.ts's own import
// fails. Without m21a-compat-gap-detect task spec decision 3 (discard the
// buffer on a caught import failure), this file's own drain would also pick
// up a-partial-eval-failure.ts's "registered before the failure"
// registration and misattribute it here.
Given("registered by the next file", function () {});
