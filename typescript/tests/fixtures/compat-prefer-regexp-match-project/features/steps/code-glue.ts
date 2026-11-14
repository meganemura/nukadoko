import { Given, defineParameterType } from "../../nukadoko-compat-shim.js";

// Both types match the group's source. cucumber-js converts the group with
// the one marked preferForRegexpMatch instead of failing the step.
defineParameterType({
  name: "codeA",
  regexp: /[A-Z]+/,
  transformer: (s: string) => `A:${s}`,
});

defineParameterType({
  name: "codeB",
  regexp: /[A-Z]+/,
  transformer: (s: string) => `B:${s}`,
  preferForRegexpMatch: true,
});

Given(/^the code ([A-Z]+)$/, function (code: unknown) {
  if (code !== "B:ABC") {
    throw new Error(`expected B:ABC, got ${String(code)}`);
  }
});
