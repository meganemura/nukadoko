import { defineConfig } from "./nukadoko-shim.js";

// The hooks in features/support/run-hooks.ts fail when hooks.json says so.
// Two environments (the program's environments) that declare the condition
// `banner` off and on, and set BANNER to match, so a scenario tagged for
// one side is a control on the other, where its Then breaks. The env files
// are demoted with `secrets.public`: a copied fixture is not a git
// repository, so they would otherwise classify as secret sources and be
// redacted from the records.
// `staging` declares no conditions, so a run with no --env leaves it out
// and runs flag-off and flag-on.

export default defineConfig({
  secrets: { public: ["BANNER"] },
  program: () => ({
    environments: {
      staging: { envFiles: [".env.flag-on"] },
      "flag-off": { envFiles: [".env.flag-off"], conditions: { banner: false } },
      "flag-on": { envFiles: [".env.flag-on"], conditions: { banner: true } },
    },
  }),
});
