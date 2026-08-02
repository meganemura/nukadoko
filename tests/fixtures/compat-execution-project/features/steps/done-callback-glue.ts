import { When } from "../../nukadoko-compat-shim.js";

// m21b-compat-execution task spec, item 5: this function declares one more
// parameter (`done`) than it is actually called with (this step captures
// nothing) — cucumber-js's own signal for a `done`-callback-style step.
// nukadoko never provides a `done` argument, so calling `done()` here would
// throw "done is not a function" if this were ever actually invoked; the
// arity check must catch it *before* the call and fail with a readable
// message instead.
When("a legacy step expects a done callback", function (done) {
  done();
});
