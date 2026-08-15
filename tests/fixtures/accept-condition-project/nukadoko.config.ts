import { defineConfig } from "./nukadoko-shim.js";

// Fixture for tests/accept-condition.test.ts — pairs an API-only feature
// (features/greeting.feature, no browser, no HTTP server needed) with one
// that destructures `page` (features/browser.feature, chromium only:
// firefox/webkit have no binary installed here, so `nuka do`/`nuka run`
// against this fixture are constrained to chromium). `environments.staging`
// exists only so a test can produce
// a second, differently-named `environment` on a scenario record via `--env
// staging` — condition filtering itself never reads this map (src/accept/
// select-run.ts's own header: only `browserType` is filtered).
export default defineConfig({
  environments: { staging: {} },
});
