import { setDefaultTimeout } from "../../nukadoko-compat-shim.js";

// cucumber-js treats a negative timeout as no timeout. -1 is the usual
// way a suite turns the limit off.
setDefaultTimeout(-1);
