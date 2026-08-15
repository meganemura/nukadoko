import { Given, Then, defineParameterType } from "../../nukadoko-compat-shim.js";

// Kind-crossing duplicate-pattern target: its stripped/normalized text
// ("duplicate text {string}") is the same as typed-duplicate-target.ts's
// typed pattern. Compat string patterns need no `{key:type}` naming —
// this is plain, unmodified cucumber-expressions syntax.
Given("duplicate text {string}", function () {
  return {};
});

// Undefined-step participation target: matches a pickle line no typed step
// covers, proving compat patterns keep it from being "undefined" — compat
// patterns count toward undefined-step detection too.
Given("a compat-only thing happens", function () {
  return {};
});

// Then-position soft-warning target.
Then("the compat outcome is observed", function () {
  return {};
});

// support-origin parameterType: no name collision (built-in or config) — it
// still merges into the one registry config.parameterTypes also uses, so
// compat and config-registered types never drift apart in meaning. `nuka
// tend`, not `nuka check`, is what lists it as a finding now (see
// tests/tend-moved-findings.test.ts, which reuses this fixture).
// See check-compat-parameter-type-collision-project for the colliding case.
defineParameterType({ name: "shout-compat", regexp: /[A-Z]+/, transformer: (s: string) => s });
