import { Then } from "../../nukadoko-compat-shim.js";
import type { CustomWorld } from "../support/world.js";

Then("the declared listing is set to {string}", function (this: CustomWorld, id: string) {
  this.listing = { id };
});

Then("the declared listing reads back {string}", function (this: CustomWorld, expected: string) {
  if (this.listing?.id !== expected) {
    throw new Error(
      `expected listing.id to be "${expected}", got ${JSON.stringify(this.listing)}`,
    );
  }
});

// Deliberately the wrong shape at run time (`id` is a number, not a
// string) — the cast is what lets this compile; the zod schema, not
// TypeScript, is what actually catches it (m2c-typed-world task spec, item
// 2: an invalid declared write throws, and is never recorded as a write).
Then("the declared listing is set invalidly", function (this: CustomWorld) {
  this.listing = { id: 42 } as unknown as CustomWorld["listing"];
});
