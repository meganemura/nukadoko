import { setDefaultTimeout } from "../../nukadoko-compat-shim.js";

// Two calls, on purpose (m22-compat-run-scope task spec, item 1: "複数回呼ば
// れたら最後の呼び出しが勝つ") — the first value (999999ms) would never fire
// against any sleep this fixture's own steps/hooks use, so every test
// against this fixture that observes a ~20ms failure also proves the second
// call, not the first, is what took effect.
setDefaultTimeout(999_999);
setDefaultTimeout(20);
