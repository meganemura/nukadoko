import { defineProgram } from "./nukadoko-shim.js";

// `staging` declares no conditions, so a run with no --env leaves it out
// and runs flag-off and flag-on.
export default defineProgram({
  environments: {
    staging: { envFiles: [".env.flag-on"] },
    "flag-off": { envFiles: [".env.flag-off"], conditions: { banner: false } },
    "flag-on": { envFiles: [".env.flag-on"], conditions: { banner: true } },
  },
});
