import { Then } from "../../nukadoko-compat-shim.js";
import type { CustomWorld } from "../support/world.js";

// Proves a Before hook's own state on the World is visible to a later step
// (m2b-compat-execution task spec, item 5: state a Before hook sets on the
// World is read by a later step).
Then("the world visit count is {int}", function (this: CustomWorld, expected: number) {
  if (this.visits !== expected) {
    throw new Error(`expected visits to be ${expected}, got ${this.visits}`);
  }
});

// Accessing `this.page` before `await this.openPage()` ever resolved must
// fail clearly (m2b-compat-execution task spec, decision 1's two-tier
// design) — this step lets the getter's own throw become an ordinary step
// failure, so the test can assert on its message.
Then("the unopened page getter is accessed", function (this: CustomWorld) {
  void this.page;
});

// `attach`/`log`/`link` are held, not dropped (m2b-compat-execution task
// spec, item 1) — nothing reads them yet (M2's slice D), but existing glue
// that calls them (a common cucumber-js pattern) must not crash on import
// switch (docs/spec.md, migration-door rule).
Then("attach, log, and link are all callable without crashing", function (this: CustomWorld) {
  this.attach("some data", "text/plain");
  this.log("a log line");
  this.link("https://example.com", "example");
});
