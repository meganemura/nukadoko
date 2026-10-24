import { defineProgram } from "./nukadoko-shim.js";

export default defineProgram({
  environments: {
    staging: {
      envFiles: [".env.staging-missing"],
    },
  },
});
