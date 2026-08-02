import { attachment, label, link, logStep, parameter, step as allureStep } from "allure-js-commons";
import { Given } from "../../nukadoko-compat-shim.js";

// Proves the compat door (m2d-allure-shim task spec, item 2's "本流") — an
// import switch to "nukadoko/compat" never touched this file's own
// "allure-js-commons" import; every one of these calls is unmodified
// existing-suite glue.
Given(
  "a compat step declares allure attachment label link parameter and a logged step",
  async function () {
    await label("owner", "team-nukadoko");
    await link("https://example.com/ticket/1", "ticket");
    await parameter("mode", "smoke");
    await attachment("evidence", "hello from compat", "text/plain");
    await logStep("a logged sub-step");
    await allureStep("a nested step", () => {});
  },
);
