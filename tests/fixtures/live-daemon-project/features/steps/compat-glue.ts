import { Given } from "../../nukadoko-compat-shim.js";

// One compat ("support") step: proves daemon.ts refuses a compat entry at
// dispatch time (it has no typed contract to run individually) rather than
// merely omitting it from `nuka do`'s own vocabulary.
Given("a legacy step runs", function () {});
