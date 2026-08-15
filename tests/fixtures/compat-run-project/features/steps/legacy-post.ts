import { Then } from "../../nukadoko-compat-shim.js";

// Then-position compat step that observes a network write. Compat has no
// `mutates` declaration to trust at all (`mutates: null`), so trusting the
// declaration has nothing to apply to here either — the Then-position
// measured check this step used to fail against is gone for every kind, not
// just typed ones, so this compat step now passes too. `this.openRequest()`
// is still the measured door; the write still lands on the step record's
// `observed`.
Then("a legacy POST happens", async function () {
  await this.openRequest();
  await this.request.post("/write");
});
