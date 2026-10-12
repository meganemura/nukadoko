import { Given, defineParameterType } from "../../nukadoko-compat-shim.js";

defineParameterType({
  name: "color",
  regexp: /red|blue/,
});

Given("a {color} brush is ready", function () {});
