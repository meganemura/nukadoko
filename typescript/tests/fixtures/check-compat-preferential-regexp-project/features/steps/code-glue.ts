import { Given, defineParameterType } from "../../nukadoko-compat-shim.js";

// Both types prefer the same regexp, which cucumber-expressions refuses.
defineParameterType({ name: "codeA", regexp: /[A-Z]+/, preferForRegexpMatch: true });
defineParameterType({ name: "codeB", regexp: /[A-Z]+/, preferForRegexpMatch: true });

Given(/^the code ([A-Z]+)$/, function () {});
