import { defineConfig } from "nukadoko";

// This is the INNER project (selftest-suite/README-equivalent lives in
// run-selftest.mjs's header comment): selftest-suite's own steps drive it
// with `nuka run` as a subprocess, on both tracks, and its own
// `.nukadoko/allure-results/` is what those steps assert on. It is not
// itself part of the swap (selftest-suite/nukadoko.config.ts, the OUTER
// project, is).
//
// No baseURL, no browser: this stage only needs pure-step scenarios
// (selftest-suite task spec, "ブラウザ" section), the same non-browser
// shape as tests/fixtures/run-project.
export default defineConfig({});
