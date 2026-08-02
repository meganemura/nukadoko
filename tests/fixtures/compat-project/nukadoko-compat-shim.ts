// Fixture-only re-export, the "nukadoko/compat" counterpart of
// nukadoko-shim.ts in this same directory: lets step files under this
// fixture import Given/When/Then via a short, stable relative path instead
// of the published subpath.
//
// Not the bare `"nukadoko/compat"` specifier a real project uses, on
// purpose: every fixture permanently committed under tests/fixtures/** is
// also typechecked by `tsc -p tsconfig.json` (its "include" is
// `tests/**/*.ts`), and a bare `"nukadoko/compat"`/`"nukadoko"` specifier
// only resolves once tests/helpers/fixtures.ts's `ensureNukadokoShim()` has
// run and created tests/.tmp-fixtures/node_modules/nukadoko at test time —
// which does not exist yet when `tsc` runs. Every existing typed-step
// fixture already avoids the bare "nukadoko" specifier for exactly this
// reason (see any tests/fixtures/*/nukadoko-shim.ts); this file extends the
// same discipline to "nukadoko/compat". tests/compat-discover.test.ts has a
// dedicated test that writes a *non-committed* step file at run time, using
// the real bare `"nukadoko/compat"` specifier against the real package.json
// `exports` shape (via the extended `ensureNukadokoShim()`), to prove that
// resolution path works too.
export * from "../../../src/compat/index.js";
