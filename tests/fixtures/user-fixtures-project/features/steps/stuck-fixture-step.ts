import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a stuck fixture is used",
  description: "Destructures stuckFixture — this fixture never settles and never calls use()",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ stuckFixture }: any) {
    void stuckFixture;
    return {};
  },
});
