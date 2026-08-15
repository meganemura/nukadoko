import { Given } from "../../nukadoko-compat-shim.js";

// Compat half of parameter-type-unused.ts's "used" proof: this pattern
// references "used-type" directly (compat prose needs no `{key:type}`
// naming, docs/spec.md "Compat steps"), and features/tending.feature binds
// it.
Given("a shout {used-type} is heard", function () {
  return {};
});

// Proves pattern-unbound.ts's own scope note: "compat step は対象外" —
// this pattern is never bound by any feature line either,
// which would trip `pattern-unbound` if it were a typed step the way
// unbound-step.ts is, but compat steps are unused mid-migration by design
// (docs/spec.md "Compat steps") and must produce nothing here.
Given("a compat thing that nobody calls happens", function () {
  return {};
});
