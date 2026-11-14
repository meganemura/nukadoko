// Responsibility: the "nukadoko/matching" package surface (docs/spec.md
// "Typed steps") — a static, single-pattern matching predicate for a caller
// outside this package (an editor extension, for instance) that needs to
// know which typed or compat step a piece of Gherkin text binds to, without
// pulling in `src/binding/*`'s other symbols (this file's own
// `resolveStaticPattern` is what calls those; nothing else here does).
export { resolveStaticPattern } from "./resolve-static-pattern.js";
export type { StaticPatternInput, StaticPatternResolution } from "./resolve-static-pattern.js";
