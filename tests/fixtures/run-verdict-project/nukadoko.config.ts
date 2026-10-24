import { defineConfig } from "./nukadoko-shim.js";

// Two environments (nukadoko.program.ts) that declare the condition
// `banner` off and on, and set BANNER to match, so a scenario tagged for
// one side is a control on the other, where its Then breaks. The env files
// are demoted with `secrets.public`: a copied fixture is not a git
// repository, so they would otherwise classify as secret sources and be
// redacted from the records.
export default defineConfig({
  secrets: { public: ["BANNER"] },
});
