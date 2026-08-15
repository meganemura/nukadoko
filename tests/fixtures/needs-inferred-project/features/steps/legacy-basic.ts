import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Pre-migration shape:
// a bare, un-destructured first argument, so `fixtureParameterNames` throws
// `FixtureNotDestructuredError` and `needs`/`needs_browser` stay unreadable.
// Touches one real fixture (`ctx.page`, a known name — must end up in
// `needs_inferred`) and one non-fixture helper call (`ctx.someHelper()`, not
// a known name — must be filtered out). The
// helper call is cast only so this file itself keeps type-checking
// (`StepFixtures` genuinely has no such member); the scan this file
// exercises reads `fn.toString()`'s own raw text, which still carries
// "ctx.someHelper()" either way. Never actually runs.
export default defineStep({
  pattern: "a legacy basic step runs",
  description: "Un-destructured first argument, touches ctx.page and a non-fixture helper — never actually runs",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run(ctx, args) {
    void args;
    void ctx.page;
    (ctx as unknown as { someHelper(): void }).someHelper();
    return {};
  },
});
