import { defineConfig } from "nukadoko";

// This is the INNER project (selftest-suite/README-equivalent lives in
// run-selftest.mjs's header comment): selftest-suite's own steps drive it
// with `nuka run` as a subprocess, on both tracks, and its own
// `.nukadoko/allure-results/` is what those steps assert on. It is not
// itself part of the swap (selftest-suite/nukadoko.config.ts, the OUTER
// project, is).
//
// No baseURL: most scenarios here launch no browser at all, by design (the
// stage 1-3 scenarios must not get slower), the same non-browser shape as
// tests/fixtures/run-project. browser-evidence.feature is the one
// exception -- its own step and Before hook
// do launch a browser, but only ever navigate a `data:` URL, so there is
// still no real app for a `baseURL` to point at.
export default defineConfig({});
