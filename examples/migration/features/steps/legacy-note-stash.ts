import { Given, Then } from "nukadoko/compat";
import type { MigrationWorld } from "../support/world.js";

// The World-bag stash this migration hasn't reached yet (README.md calls
// this out on purpose): `this.note` is an ordinary, undeclared own property
// -- no ../support/world.ts entry for it -- so nukadoko validates nothing
// about this write, but still measures it: whichever step runs this still
// gets "note" recorded in its step record's `world.writes`/`world.reads`, the
// data flow a plain `this.foo` used to hide entirely.
Given("a legacy note {string} is stashed", function (this: MigrationWorld, note: string) {
  this.note = note;
});

Then("the stashed note reads {string}", function (this: MigrationWorld, expected: string) {
  if (this.note !== expected) {
    throw new Error(`expected the stashed note to read "${expected}", got ${JSON.stringify(this.note)}`);
  }
});
