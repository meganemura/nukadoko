import { When } from "../../nukadoko-compat-shim.js";

// Same pattern text as a-glue.ts's Given call, under a different keyword —
// keyword carries no identity for compat registrations, so this is a
// duplicate compat step (DuplicateCompatStepError), not two distinct steps.
When("shared pattern here", function () {
  return {};
});
