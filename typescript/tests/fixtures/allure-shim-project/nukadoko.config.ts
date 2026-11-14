import { defineConfig } from "./nukadoko-shim.js";

// ".env.secret" is untracked by git once copied under tests/.tmp-fixtures/
// (same convention as tests/fixtures/run-secrets-project's own .env.secret)
// — every value it defines becomes a secret source (docs/spec.md "Secrets"),
// used by this fixture's own declared-redaction scenario
// (tests/compat-allure-shim.test.ts).
export default defineConfig({
  envFiles: [".env.secret"],
});
