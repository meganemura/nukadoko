import { When } from "../../nukadoko-compat-shim.js";

// m21b-compat-execution task spec, item 4: cucumber-js interprets these two
// string returns as their own outcomes; nukadoko doesn't implement either,
// so both must fail loudly instead of quietly passing.

When("a legacy step returns pending", function () {
  return "pending";
});

When("a legacy step returns skipped", function () {
  return "skipped";
});
