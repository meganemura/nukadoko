import { defineConfig } from "./nukadoko-shim.js";

// Fixture for m1-environments: named environments covering baseURL/envFiles
// layering, `policy: "read-only"`, and the `version` probe (success and
// throw). No real HTTP server is needed — the steps under features/steps/
// only ever read `ctx.baseURL`/`ctx.env`, never `ctx.request()`/`ctx.page()`
// — so every baseURL here is a plain string, not an ephemeral test-server
// port like session-project/secrets-project need. `.env.base`/`.env.staging`
// are demoted via `secrets.public`: a copied-fixture temp directory (see
// tests/helpers/fixtures.ts) is never itself a git repository with these
// files tracked, so without this they would classify as secret sources and
// get redacted out of the very step records these tests assert on — this
// fixture is about environment layering, not secrets classification.
export default defineConfig({
  baseURL: "http://top.example",
  envFiles: [".env.base"],
  secrets: { public: ["KEY", "SHARED"] },
  environments: {
    staging: {
      baseURL: "http://staging.example",
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
