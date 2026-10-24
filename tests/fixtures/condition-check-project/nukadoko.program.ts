import { defineProgram } from "./nukadoko-shim.js";

// Two environments that differ in one condition, and a deployment target
// that declares none.
export default defineProgram({
  environments: {
    "flag-off": { conditions: { banner: false } },
    "flag-on": { conditions: { banner: true } },
    staging: { url: "http://127.0.0.1:3299" },
  },
});
