import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose, same as sections-project's/polls-
// project's own rationale: every scenario here is about
// `evidence.attach`/`.path`'s own bookkeeping, not browser evidence, so no
// browser and no HTTP server are needed. `.env.secret` is untracked by git
// (see run-secrets-project's own comment: the same convention), so
// classify-env-files.ts treats every value it defines as a secret source —
// exercised by attach-secret.ts, which proves redaction reaches
// `evidence.attachments[].name`/`.file`.
export default defineConfig({
  envFiles: [".env.secret"],
});
