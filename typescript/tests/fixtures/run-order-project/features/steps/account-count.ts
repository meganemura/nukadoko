import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the account count is {count:int}",
  description: "The number of accounts GET /accounts lists",
  args: z.object({ count: z.number().int().nonnegative() }),
  async observe({ request }) {
    const body = (await (await request.get("/accounts")).json()) as { names: string[] };
    return { names: body.names };
  },
  claims: [{ actual: "names", count: true, compare: "equal", expected: "count" }],
});
