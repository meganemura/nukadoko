import { Given } from "../../nukadoko-compat-shim.js";

// Compat-step boundary: a compat step has no
// args schema at all, so there is nothing for the new check to look at —
// unlike a typed step's declared `args`, an unbound compat glue function
// parameter is just a plain JS argument, never a validated required key.
Given("a compat widget exists", function () {
  return {};
});
