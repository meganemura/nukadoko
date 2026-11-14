// Side-effect import only: broken.ts fails to transform (its own redeclared
// "page"), and Node's ESM loader caches that failure and rethrows the
// identical error object to this file too (measured directly, same
// behavior tests/check-import-failure-grouping.test.ts already exercises
// for a location-less message). The message this file's own importFailures
// entry gets therefore names broken.ts's location, not this file's own —
// exactly the "message points at a different file" case where `nuka check`
// must not fill `line` for this entry.
import "./broken.js";
