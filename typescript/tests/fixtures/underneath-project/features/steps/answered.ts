import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import get from "./get.js";

export default defineStep({
  pattern: "the program answered {status:int}",
  description: "Checks the status the program answered the last GET with",
  args: z.object({ status: z.number().int(), got: z.number().int() }),
  from: { got: [get, "status"] },
  claims: [{ actual: "got", compare: "equal", expected: "status" }],
});
