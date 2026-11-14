import { AfterAll, BeforeAll } from "../../nukadoko-compat-shim.js";

// Declares one more parameter than nukadoko ever calls a run-scope hook
// with: cucumber-js would infer a done() callback from this same shape;
// nukadoko has no callback form, and detects it by arity alone, before
// calling the function at all (src/run/run-scenario.ts's own
// doneCallbackMessage doc comment). Exists to reach cli/run.ts's own
// runOneRunHook arity check for a *run-scope* hook specifically. The
// scenario-level Before/After version of this same check has no test
// either, but that is src/run/run-scenario.ts's own file, out of this
// fixture's scope.
BeforeAll(function (done) {
  done();
});

// Returns "pending" the same way a cucumber-js step/hook signals
// "not implemented yet": nukadoko does not interpret either string
// specially (src/run/run-scenario.ts's own pendingOrSkippedMessage doc
// comment) and reports it as this hook's own failure instead. Zero
// declared parameters, so this hook clears the arity check above and
// reaches the pending/skipped check on its own.
AfterAll(function () {
  return "pending";
});
