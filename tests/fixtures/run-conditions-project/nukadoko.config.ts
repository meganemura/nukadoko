import { defineConfig } from "./nukadoko-shim.js";

// Two environments (nukadoko.program.ts) that differ in one env value, so
// one scenario passes in one and fails in the other. The env files are
// demoted with `secrets.public`: a copied fixture is not a git repository,
// so they would otherwise classify as secret sources and be redacted from
// the records.
export default defineConfig({
  secrets: { public: ["BANNER"] },
});
