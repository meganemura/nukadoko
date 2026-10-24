import { defineProgram } from "./nukadoko-shim.js";

export default defineProgram({
  environments: {
    "flag-on": { envFiles: [".env.flag-on"], version: () => "2.0.0", url: "http://127.0.0.1:3201" },
    "flag-off": { envFiles: [".env.flag-off"] },
  },
});
