// A distinct failure (a plain synchronous throw, not the shared
// require()-in-ESM cause a-imports-shared.ts/b-imports-shared.ts share)
// proves a different message stays its own group rather than being folded
// in with theirs.
throw new Error("boom: a different cause than the shared require() one");
