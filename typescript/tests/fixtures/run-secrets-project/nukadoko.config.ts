import { defineConfig } from "./nukadoko-shim.js";

// ".env.secret" is untracked by git (see the repo's own .gitignore negation
// comment for tests/fixtures/**/.env.*) — once copied under
// tests/.tmp-fixtures/ (itself gitignored), classify-env-files.ts's `git
// ls-files` finds it untracked there too, so every value it defines is a
// secret source (docs/spec.md "Secrets"), same convention as
// tests/fixtures/secrets-project.
export default defineConfig({
  envFiles: [".env.secret"],
});
