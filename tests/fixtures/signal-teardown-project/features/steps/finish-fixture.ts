import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the fixture finishes",
  description: "Names tenant and ledger, then returns",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ tenant, ledger }: { tenant: { id: string }; ledger: { id: string } }) {
    void tenant;
    void ledger;
    return {};
  },
});
