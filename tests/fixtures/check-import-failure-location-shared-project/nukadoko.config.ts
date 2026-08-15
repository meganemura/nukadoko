import { defineConfig } from "./nukadoko-shim.js";

// Two step files, one that fails to
// transform on its own (broken.ts, a redeclared fixture-bag name) and one
// that only side-effect imports it (via-import.ts) — Node's ESM loader
// caches broken.ts's failure and rethrows the identical error to
// via-import.ts too. This project exists to prove two things at once: the
// message's own `<path>:<line>:<col>` location is attributed only to
// broken.ts (whose own path it actually names), never to via-import.ts,
// *and* that the two entries still share one message byte-for-byte, so
// `nuka check`'s human formatter groups them the same way it already
// groups a location-less shared cause (tests/check-import-failure-grouping
// .test.ts) — without ever printing a line number for the group, since a
// message shared across files can't say which one file it belongs to.
export default defineConfig({});
