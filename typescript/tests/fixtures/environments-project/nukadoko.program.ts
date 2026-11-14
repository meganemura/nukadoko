import { defineProgram } from "./nukadoko-shim.js";

export default defineProgram({
  url: "http://top.example",
  environments: {
    staging: {
      url: "http://staging.example",
      envFiles: [".env.staging"],
    },
    "no-overrides": {},
    readonly: {
      policy: "read-only",
    },
    "probe-ok": {
      version: () => "1.2.3",
    },
    "probe-throws": {
      version: () => {
        throw new Error("probe boom");
      },
    },
  },
});
