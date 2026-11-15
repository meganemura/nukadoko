import { defineConfig } from "./nukadoko-shim.js";

// Fixture for named environments (the program's environments) covering url and
// envFiles layering, `policy: "read-only"`, and the `version` probe
// (success and throw). No real HTTP server is needed: the steps under
// features/steps/ only ever read `ctx.baseURL`/`ctx.env`, never
// `ctx.request()`/`ctx.page()`, so every url is a plain string, not an
// ephemeral test-server port like secrets-project needs.
// `.env.base`/`.env.staging`
// are demoted via `secrets.public`: a copied-fixture temp directory (see
// tests/helpers/fixtures.ts) is never itself a git repository with these
// files tracked, so without this they would classify as secret sources and
// get redacted out of the very step records these tests assert on — this
// fixture is about environment layering, not secrets classification.
export default defineConfig({
  envFiles: [".env.base"],
  secrets: { public: ["KEY", "SHARED"] },
  program: () => ({
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
  }),
});
