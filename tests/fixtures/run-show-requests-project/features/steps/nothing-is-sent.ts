import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "nothing is sent",
  description: "A step that sends no request",
  args: z.object({}),
  async run() {},
});
