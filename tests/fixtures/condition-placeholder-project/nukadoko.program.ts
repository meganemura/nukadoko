import { defineProgram } from "./nukadoko-shim.js";

// BANNER comes from each environment's own condition, so an environment
// cannot declare one side of the switch and run the other. staging
// declares none, so {condition.banner} has no value there.
export default defineProgram({
  env: { BANNER: "{condition.banner}" },
  environments: {
    "flag-off": { conditions: { banner: false } },
    "flag-on": { conditions: { banner: true } },
    staging: {},
  },
});
