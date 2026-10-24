import { defineProgram } from "./nukadoko-shim.js";

// Programs nukadoko does not start: each environment's world is only a URL.
export default defineProgram({
  url: "http://default.example",
  environments: {
    staging: { url: "http://staging.example" },
    production: { url: "http://production.example" },
  },
});
