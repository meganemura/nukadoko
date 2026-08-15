import { Given, Then, When } from "../../nukadoko-compat-shim.js";
import type { CustomWorld } from "../support/world.js";

// An ordinary bag field, read and written across two steps in the same
// scenario (tests/compat-typed-world.test.ts: measurement is deduplicated
// and in access order, per step).
When("the visit count is incremented", function (this: CustomWorld) {
  this.visits += 1;
});

Then("the visit count is {int}", function (this: CustomWorld, expected: number) {
  if (this.visits !== expected) {
    throw new Error(`expected visits to be ${expected}, got ${this.visits}`);
  }
});

// Does nothing to the World at all — the step record's own `world` field must
// be omitted entirely (m2c-typed-world task spec, item 3: when both halves
// are empty, the field is omitted).
Then("a step that never touches the World runs", function (this: CustomWorld) {
  void this;
});

// Reconcile's own one-step-behind limit (proto-typed-world/findings.md's
// "hole 1", partial fix): `freshField` does not exist as an accessor yet
// when this step's own body creates it, so this write is not measured —
// the *next* step's read is (tests/compat-typed-world.test.ts asserts both
// halves). Cast through `Record<string, string>`, not `this.freshField`
// directly: an undeclared key is exactly what stays untyped under
// `defineWorld`'s gradual-typing story (this task's spec, item 4's own
// header) — nothing here is a workaround for a typing gap.
Given("a fresh field is created with {string}", function (this: CustomWorld, value: string) {
  (this as unknown as Record<string, string>).freshField = value;
});

Then("the fresh field equals {string}", function (this: CustomWorld, expected: string) {
  const actual = (this as unknown as Record<string, string>).freshField;
  if (actual !== expected) {
    throw new Error(`expected freshField to be "${expected}", got ${JSON.stringify(actual)}`);
  }
});

// The #private integration test itself (proto-typed-world/findings.md's
// central claim, this task's spec's own required test): must not crash, and
// must return the real value, proving `this` inside `revealSecret()` is the
// literal instance, never a wrapper.
Then("the secret is revealed correctly", function (this: CustomWorld) {
  if (this.revealSecret() !== 42) {
    throw new Error("revealSecret() did not return the expected private value");
  }
});
