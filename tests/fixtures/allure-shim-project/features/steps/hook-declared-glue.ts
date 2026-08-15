import { attachment, label } from "allure-js-commons";
import { Before, Given } from "../../nukadoko-compat-shim.js";

// Proves item 4/5: a hook has no step record of its own, so its own declared
// data lands on record.hooks[].declared instead (src/run/record-types.ts).
// Tagged so this fixture project's *other* feature files (this whole
// features/ tree is discovered together, regardless of which single file a
// given `nuka run` invocation selects — src/discover/discover-steps.ts walks
// the whole featuresDir) never pick this hook up.
Before({ tags: "@declares-hook" }, async function () {
  await label("hook-owner", "team-nukadoko");
  await attachment("hook-evidence", "hello from a Before hook", "text/plain");
});

Given("a plain step runs under a declaring hook", function () {
  // Nothing declared here — proves the hook's own declared data landed on
  // the hook's own record, not this step's step record.
});
