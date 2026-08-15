import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Same fixture as uses-tenant-step.ts, but always throws — the scenario
// this step is bound in exists to exercise teardown on a *failed* scenario,
// where `outcome` passed to `use()`
// must be `"failed"`, and the fixture's own conditional cleanup must not
// run (see nukadoko.config.ts's own `tenant` fixture).
export default defineStep({
  pattern: "a tenant is used and the step fails",
  description: "Destructures tenant, then always throws",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ tenant }: any) {
    void tenant;
    throw new Error("deliberate failure to exercise teardown on a failed scenario");
  },
});
