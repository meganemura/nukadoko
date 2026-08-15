import { Then } from "../../nukadoko-compat-shim.js";

// Then-position compat step that observes a network write. Compat has no
// `mutates` declaration to trust at all (`mutates: null`, m2b-compat-
// execution task spec, item 2), so t2-trust-declaration's "trust the
// declaration" has nothing to apply to here either — the Then-position
// measured check this step used to fail against is gone for every kind, not
// just typed ones, so this compat step now passes too. `this.openRequest()`
// is still the measured door (m2b-compat-execution task spec, decision 1);
// the write still lands on the step record's `observed`.
Then("a legacy POST happens", async function () {
  await this.openRequest();
  await this.request.post("/write");
});
