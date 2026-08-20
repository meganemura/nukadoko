import { When } from "../../nukadoko-compat-shim.js";

// A trivial step shared by ../one-scenario.feature: the scenario itself is
// never reached by the BeforeAll case below (BeforeAll's own arity refusal
// stops it), and always reached by the AfterAll case (AfterAll runs whether
// or not BeforeAll or any scenario passed).
When("a no-op step runs", function () {});
