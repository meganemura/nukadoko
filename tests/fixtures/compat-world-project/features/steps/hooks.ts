import { After, Before } from "../../nukadoko-compat-shim.js";
import type { CustomWorld } from "../support/world.js";

// Registration order matters for tests/compat-world.test.ts's assertions
// (m2b-compat-execution task spec, item 5): Before hooks run in this order;
// After hooks run in the reverse of it.

// Runs for every scenario.
Before(function (this: CustomWorld) {
  this.visits += 1;
});

// Only for a scenario tagged @tagged (m2b-compat-execution task spec, item
// 5: "tagged Before がタグ無し scenario で走らない").
Before({ tags: "@tagged" }, function (this: CustomWorld) {
  this.visits += 100;
});

// Only for a scenario *without* @excluded (this task's spec, item 5:
// "not @tag").
Before({ tags: "not @excluded" }, function (this: CustomWorld) {
  this.visits += 10;
});

// Only for the scenario tagged @before-fails (this task's spec, item 5:
// "Before 失敗で全 skip + record.hooks に failed").
Before({ tags: "@before-fails" }, function () {
  throw new Error("before hook exploded");
});

// Runs for every scenario, regardless of whether a Before hook or a step
// failed (this task's spec, item 5: "After が失敗時も走る").
After(function (this: CustomWorld) {
  this.visits += 1000;
});
