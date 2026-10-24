import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Reads the program through `request`, which resolves against the world's
// URL, and returns what the program and this step's own process each got.
export default defineStep({
  pattern: "I ask the program who it is",
  description: "GET /whoami from the world's program",
  args: z.object({}),
  returns: z.object({
    db: z.string(),
    token: z.string(),
    stepDb: z.string(),
    processDb: z.string(),
  }),
  mutates: false,
  async run({ request, env }) {
    const response = await request.get("/whoami");
    const body = (await response.json()) as { db: string; token: string };
    return { db: body.db, token: body.token, stepDb: env.DB ?? "", processDb: process.env.DB ?? "" };
  },
});
