import { Given, Then, When } from "../../nukadoko-compat-shim.js";

// Fixture-only legacy glue: exercises string and RegExp patterns across all
// three keyword aliases (m2a-compat-registry task spec: Given/When/Then are
// all aliases of the same registration function), one file registering
// three compat steps at once — unlike a typed step, compat identity is the
// pattern, not the file (tests/compat-discover.test.ts,
// tests/compat-cli.test.ts).

Given("a legacy project {string} exists", function (name: string) {
  return { name };
});

When(/^a legacy request is made$/, function () {
  return {};
});

Then("the legacy result is {string}", function (value: string) {
  return { value };
});
