// Fixture-only re-export: lets nukadoko.config.ts import from a short,
// stable relative path instead of reaching across three directory levels to
// src/index.ts. Not part of the public API — a real project imports from
// the published "nukadoko" package name.
export * from "../../../src/index.js";
