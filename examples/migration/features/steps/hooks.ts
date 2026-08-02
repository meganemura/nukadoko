import { Before } from "nukadoko/compat";
import type { MigrationWorld } from "../support/world.js";

// The one Before hook this suite keeps (README.md's Stage 1: "the measured
// door"). Before switching to nukadoko/compat, a hook like this one had to
// bootstrap its own Playwright APIRequestContext by hand (its own baseURL,
// its own disposal); `this.openRequest()` replaces that bootstrapping with
// the harness's own lazily-launched, memoized request context -- the exact
// same object a typed step's `ctx.request()` reaches (docs/spec.md "Compat
// steps") -- so this hook and every step in the same pickle, compat or
// typed, share one Playwright context, cookies included, instead of each
// piece of glue launching (and measuring nothing about) its own.
Before(async function (this: MigrationWorld) {
  await this.openRequest();
});
