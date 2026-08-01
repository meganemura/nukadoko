// Responsibility: the single marker that lets discovery tell "this default
// export is a step produced by defineStep" apart from an arbitrary object a
// step file might export by mistake. Not responsible for anything about what
// a step does.
//
// Why Symbol.for (global registry) and not a plain module-local Symbol():
// step files are loaded through tsx's tsImport, which resolves and executes
// each file in its own module graph, separate from the one that loads this
// package's own source. A plain `Symbol("nukadoko.step")` created here would
// therefore not be `===` to the one a step file sees after importing
// `defineStep` and calling it — two different instances of this very module
// would exist across that boundary. `Symbol.for` reads from the process-wide
// symbol registry, which is shared across module graphs in the same process,
// so the identity check still holds. Verified empirically before writing
// this: a plain Symbol failed the cross-realm equality check, Symbol.for did
// not.
export const STEP_BRAND: unique symbol = Symbol.for("nukadoko.step");
