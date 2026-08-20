import { defineConfig } from "./nukadoko-shim.js";

// `.env.secret` is never committed: a test runs this fixture from a
// throwaway temp copy (tests/helpers/fixtures.ts's `copyFixtureToTempDir`),
// so `git ls-files` never finds it there — every key it defines becomes a
// secret automatically, with no `secrets.redact` needed
// (src/secrets/classify-env-files.ts: an untracked envFile is a secret
// source by default).
export default defineConfig({
  envFiles: [".env.secret"],
});
