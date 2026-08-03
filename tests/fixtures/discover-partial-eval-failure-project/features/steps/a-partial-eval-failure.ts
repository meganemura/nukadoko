import { Given } from "../../nukadoko-compat-shim.js";

// Registers a compat step, then fails partway through its own module-body
// evaluation — the shape CommonJS `require()` inside an ESM file actually
// takes (it throws during evaluation, not at ESM's earlier link phase;
// m21-compat-gap findings.md, Q2/Q3). A plain synchronous `throw` after a
// real registration reproduces the same "partial registration, then a
// failure" shape without this fixture needing an actual CJS dependency.
// Named to sort before b-next-file.ts (src/discover/discover-steps.ts walks
// files in name order) so tests/discover-steps.test.ts's regression test
// for m21a-compat-gap-detect task spec decision 3 can rely on this file
// being the *first* one discovery imports.
Given("registered before the failure", function () {});

throw new Error("boom: fails partway through this file's own evaluation");
