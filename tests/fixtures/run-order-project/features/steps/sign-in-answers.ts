import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import signIn from "./sign-in.js";

export default defineStep({
  pattern: "the sign-in answers {expected:int}",
  description: "The status the last sign-in got",
  args: z.object({ expected: z.number().int(), status: z.number().int() }),
  from: { status: [signIn, "status"] },
  claims: [{ actual: "status", compare: "equal", expected: "expected" }],
});
