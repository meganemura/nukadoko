import { defineConfig } from "nukadoko";

// This is the OUTER project on the swap track only: `nuka run` reads this
// file when it is the thing driving this suite's own scenarios (run-
// selftest.mjs's NUKADOKO_SELFTEST_TRACK=swap track). The baseline track
// (the real cucumber-js binary) never reads this file at all: cucumber-js
// has no concept of nukadoko.config.ts.
//
// Running this suite writes THIS project's own `.nukadoko/allure-results/`
// as a side effect (the "outer" tree, see run-selftest.mjs's header
// comment for the full inner/outer distinction). That tree is not what
// this suite's own step assertions check; selftest-suite/fixture-project's
// is (the "inner" tree, the one the suite's steps drive with `nuka run` as
// a subprocess).
export default defineConfig({});
