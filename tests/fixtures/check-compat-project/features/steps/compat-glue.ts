import { Given, Then, defineParameterType } from "../../nukadoko-compat-shim.js";

// Kind-crossing duplicate-pattern target: its stripped/normalized text
// ("duplicate text {string}") is the same as typed-duplicate-target.ts's
// typed pattern. Compat string patterns need no `{key:type}` naming (this
// task's spec, item 6: no named-capture syntax required for compat string
// patterns) — this is plain, unmodified cucumber-expressions syntax.
Given("duplicate text {string}", function () {
  return {};
});

// Undefined-step participation target: matches a pickle line no typed step
// covers, proving compat patterns keep it from being "undefined" (this
// task's spec, item 6: compat patterns also count toward undefined-step
// detection).
Given("a compat-only thing happens", function () {
  return {};
});

// Then-position soft-warning target (this task's spec, item 6, second
// bullet).
Then("the compat outcome is observed", function () {
  return {};
});

// support-origin parameterType: no name collision (built-in or config) —
// `nuka check` should list it as a warning while still merging it into the
// one registry config.parameterTypes also uses (parameter-types-design.md
// "gradual compat" section). See check-compat-parameter-type-collision-
// project for the colliding case.
defineParameterType({ name: "shout-compat", regexp: /[A-Z]+/, transformer: (s: string) => s });
