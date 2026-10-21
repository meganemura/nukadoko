import { defineConfig } from "./nukadoko-shim.js";

// Two environments that differ in one env value, so one scenario passes in
// one and fails in the other. The env files are demoted with
// `secrets.public`: a copied fixture is not a git repository, so they would
// otherwise classify as secret sources and be redacted from the records.
export default defineConfig({
  secrets: { public: ["BANNER"] },
  environments: {
    "flag-on": { envFiles: [".env.flag-on"], version: () => "2.0.0", baseURL: "http://127.0.0.1:3201" },
    "flag-off": { envFiles: [".env.flag-off"] },
  },
});
