// What this is: maps nukadoko's nine ErrorKind values to Allure 3
// categories via the `nukadoko.failure` label every failed/broken result
// already carries — Allure 3's own generate/report tooling never reads a
// results directory's categories.json (unlike Allure 2), so without this
// config every nukadoko failure collapses into Allure 3's one built-in
// "Product errors" category.
//
// Drop this file at your project's root (next to nukadoko.config.ts) and
// `allure generate`/`allure report` picks it up automatically — Allure 3
// auto-detects `allurerc.{js,mjs,cjs,json,yaml,yml}` from the current
// working directory; no `--config` flag needed.
//
// Allure 2 users don't need this file at all: nukadoko's own emitter
// already writes a matching categories.json straight into allure-results/
// each run.
//
// Already have your own allurerc? Merge this `categories` array into it
// rather than replacing the whole file — and keep every entry on the
// `matchers` key shown below; mixing it with the legacy
// `matchedStatuses`/`messageRegex` keys in the same rule throws at
// generate time (see `@allurereport/core-api/dist/categories.js`).
//
// The nine `name` values below are copied verbatim from
// `src/report/allure/categories.ts`'s own `NAME_BY_KIND` — that file is
// the source of truth; a drift test (tests/allure-config-drift.test.ts)
// keeps this file's copy honest against it.
export default {
  categories: [
    {
      name: "Contract: args failed the step's schema",
      matchers: [{ labels: { "nukadoko.failure": "args_invalid" } }],
    },
    {
      name: "Contract: result failed the step's schema",
      matchers: [{ labels: { "nukadoko.failure": "result_invalid" } }],
    },
    {
      name: "Contract: the step's text couldn't bind",
      matchers: [{ labels: { "nukadoko.failure": "binding_invalid" } }],
    },
    {
      name: "Contract: a World key's write failed its schema",
      matchers: [{ labels: { "nukadoko.failure": "world_invalid" } }],
    },
    {
      name: "Contract: a Then step was observed writing",
      matchers: [{ labels: { "nukadoko.failure": "then_mutated" } }],
    },
    {
      name: "Policy: a write under a read-only environment",
      matchers: [{ labels: { "nukadoko.failure": "read_only_violation" } }],
    },
    {
      name: "Timeout",
      matchers: [{ labels: { "nukadoko.failure": "timeout" } }],
    },
    {
      name: "Compat: unsupported step shape",
      matchers: [{ labels: { "nukadoko.failure": "unsupported" } }],
    },
    {
      name: "Step error",
      matchers: [{ labels: { "nukadoko.failure": "step_error" } }],
    },
  ],
};
