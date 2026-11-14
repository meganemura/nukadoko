import { setDefaultTimeout } from "../../nukadoko-compat-shim.js";

// Two calls, on purpose (if called
// multiple times, the last call wins) — the first value (999999ms) would
// never fire against any sleep this fixture's own steps/hooks use, so every
// test against this fixture that observes a ~20ms failure also proves the
// second call, not the first, is what took effect.
setDefaultTimeout(999_999);
setDefaultTimeout(20);
