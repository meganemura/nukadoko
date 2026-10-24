import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the step asks the program through request",
  description: "GET /request and /trace-only through the request fixture",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ request }) {
    await request.get("/request");
    await request.get("/trace-only");
    return {};
  },
});
