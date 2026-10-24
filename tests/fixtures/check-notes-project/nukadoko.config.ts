import { defineConfig } from "./nukadoko-shim.js";

// tests/check-notes.test.ts's fixture: one project carrying a note of each
// step-level kind at once, each paired with a healthy step exercising the same
// mechanism so a false positive on the healthy step would fail the test
// just as loudly as a missed finding on the unhealthy one.
//
// - "used-type" is referenced by both a typed pattern (log-note.ts) and a
//   compat pattern (shout-compat.ts) — proof `parameter-type-unused` reads
//   both vocabularies, not just one.
// - "ghost-type" is never referenced anywhere: the one entry `nuka check`
//   should note.
export default defineConfig({
  parameterTypes: [
    { name: "used-type", regexp: /[a-z]+/, transformer: (s: string) => s },
    { name: "ghost-type", regexp: /[A-Z]+/, transformer: (s: string) => s },
  ],
});
