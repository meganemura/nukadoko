import { After, Before } from "../../nukadoko-compat-shim.js";
import type { CustomWorld } from "../support/world.js";

// Registration order matters for tests/compat-world.test.ts's assertions:
// Before hooks run in this order; After hooks run in the reverse of it.

// Runs for every scenario.
Before(function (this: CustomWorld) {
  this.visits += 1;
});

// Only for a scenario tagged @tagged (a tagged Before does not run for an
// untagged scenario).
Before({ tags: "@tagged" }, function (this: CustomWorld) {
  this.visits += 100;
});

// Only for a scenario *without* @excluded ("not @tag").
Before({ tags: "not @excluded" }, function (this: CustomWorld) {
  this.visits += 10;
});

// Only for the scenario tagged @before-fails (a
// Before failure skips everything else and records failed in
// record.hooks).
Before({ tags: "@before-fails" }, function () {
  throw new Error("before hook exploded");
});

// Runs for every scenario, regardless of whether a Before hook or a step
// failed.
After(function (this: CustomWorld) {
  this.visits += 1000;
});
