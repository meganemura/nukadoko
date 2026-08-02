import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import producer from "./producer.js";

// Captured on `globalThis`, not exported, because `globalThis` is the one
// channel that crosses tsx's per-namespace module cache boundary from
// outside: the test reading this capture runs under vitest's own module
// system, not the tsx registration discoverSteps() used to load this file,
// so a plain named export here would not be reachable the way the test
// needs it to be. This is tests/discover-steps.test.ts's module-identity
// test (m2pre-module-identity task spec, scope item 3): it proves
// discoverSteps()'s own direct (vocabulary) load of producer.ts and this
// file's own relative import of producer.ts return the exact same object.
(globalThis as Record<string, unknown>).__nukadokoModuleIdentityTestCapture = producer;

export default defineStep({
  pattern: "the consumer step runs",
  description:
    "No-op step; exists only to hold a relative import of producer.ts for tests/discover-steps.test.ts's module-identity test",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
