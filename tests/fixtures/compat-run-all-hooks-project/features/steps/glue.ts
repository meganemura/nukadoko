import { When } from "../../nukadoko-compat-shim.js";

// A trivial step shared by both scenarios in ../two-scenarios.feature — none
// of them care what a step does, only what runs around them.
When("a no-op step runs", function () {});
