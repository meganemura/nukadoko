// The one place this whole suite's two tracks actually differ. Every step
// and world file imports Given/When/Then/World/setWorldConstructor from
// here rather than from either library directly, so "swap the import"
// (selftest-suite task spec, "2 トラック" section) is one specifier change
// in one file instead of a second, hand-kept-in-sync copy of every step
// file.
//
// Track 1, baseline (NUKADOKO_SELFTEST_TRACK unset): binds to the real
// `@cucumber/cucumber` package, executed by the real `cucumber-js` binary
// (run-selftest.mjs's baseline track). This is the independent measuring
// instrument and must be kept running permanently, on its own, regardless
// of what track 2 does: see the next paragraph for why.
//
// Track 2, swap (NUKADOKO_SELFTEST_TRACK=swap): binds to `nukadoko/compat`
// instead, executed by `nuka run` on this same suite (run-selftest.mjs's
// swap track: `nuka run`, not the cucumber-js binary, is the OUTER runner
// on this track). A nukadoko bug on this track can corrupt both what is
// being measured (this suite's own scenario) and the thing doing the
// measuring (nukadoko's own compat registry/runtime), which is exactly why
// track 1 has to keep running on its own, unaffected by anything nukadoko
// does: it is the only track where a nukadoko bug cannot also break the
// check that would have caught it.
//
// `nukadoko/compat` resolves here via Node's self-referencing package
// resolution (this suite lives inside the nukadoko package tree, and
// package.json declares `name` + `exports`), the same subpath a real
// downstream consumer imports, not a relative path into src/, so this is
// the real published compat surface, exercised for real.
const track = process.env.NUKADOKO_SELFTEST_TRACK === "swap" ? "swap" : "baseline";

const impl = track === "swap" ? await import("nukadoko/compat") : await import("@cucumber/cucumber");

export const Given = impl.Given;
export const When = impl.When;
export const Then = impl.Then;
export const World = impl.World;
export const setWorldConstructor = impl.setWorldConstructor;
// selftest-allure task spec, decision 2: the HTTP server that serves a
// generated Allure report is started/stopped by a cucumber-js Before/After
// hook, on both tracks. Before/After go through this same swap so that
// hook, like every step above, binds to the real @cucumber/cucumber on the
// baseline track and to nukadoko/compat on the swap track, never a stray
// direct import of either that would silently register into the wrong
// registry.
export const Before = impl.Before;
export const After = impl.After;
