// Fixture-only re-export: lets step/config files under this fixture project
// import from a short, stable relative path instead of each one reaching
// across five directory levels to src/index.ts. Not part of the public API
// — a real project imports from the published "nukadoko" package name.
//
// tests/live-session.test.ts copies this fixture into a short-path temp
// directory (outside the repo tree entirely — see that file's own header
// for why) and rewrites this one file's own re-export path afterward, since
// the relative depth this line depends on only holds at this fixture's
// committed location.
export * from "../../../src/index.js";
