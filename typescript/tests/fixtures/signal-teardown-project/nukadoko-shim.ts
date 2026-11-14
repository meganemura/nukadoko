// Fixture-only re-export: lets step/config files under this fixture project
// import from a short, stable relative path instead of each one reaching
// across several directory levels to src/index.ts. Not part of the public
// API. A real project imports from the published "nukadoko" package name.
export * from "../../../src/index.js";
