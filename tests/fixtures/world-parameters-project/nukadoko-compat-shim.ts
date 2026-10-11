// Fixture-only re-export, same reason as compat-world-project's shim:
// a relative path stays valid after copyFixtureToTempDir moves the tree
// one directory deeper under tests/.tmp-fixtures.
export * from "../../../src/compat/index.js";
