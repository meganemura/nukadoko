import { defineProgram } from "./nukadoko-shim.js";

export default defineProgram({
  environments: {
    "probe-ok": {
      version: () => "9.9.9",
    },
    "probe-throws": {
      version: () => {
        throw new Error("probe boom");
      },
    },
  },
});
