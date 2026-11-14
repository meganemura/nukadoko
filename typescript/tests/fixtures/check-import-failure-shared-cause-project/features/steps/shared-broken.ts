// `require` is CommonJS-only; calling it from this ES module throws a
// ReferenceError as soon as evaluation reaches it (same trick
// discover-import-failure-project's own broken.ts uses). Two sibling step
// files below both import this module for its side effect, so both fail
// with the identical error Node's ESM loader caches and rethrows to every
// importer.
require("node:path");
