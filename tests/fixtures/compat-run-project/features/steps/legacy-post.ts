import { Then } from "../../nukadoko-compat-shim.js";

// Then-position compat step that observes a network write (this task's
// spec, item 6: run-time observation enforcement applies to compat steps
// exactly as it does to typed ones) — `this.openRequest()` is the measured
// door (m2b-compat-execution task spec, decision 1); the harness must see
// this POST for the demotion to apply.
Then("a legacy POST happens", async function () {
  await this.openRequest();
  await this.request.post("/write");
});
