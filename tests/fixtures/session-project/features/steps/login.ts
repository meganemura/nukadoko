import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// No `pattern`/`patterns`: CLI-only vocabulary, same convention as
// basic-project's list-projects.ts. Hits the test server's /set-cookie via
// request, which responds with a Set-Cookie header — the request
// context's storageState after this is what a `--session` run should
// persist (tests/session.test.ts's request round-trip).
export default defineStep({
  description: "Hit /set-cookie so the request context picks up a cookie",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: true,
  async run({ request }) {
    const res = await request.get("/set-cookie");
    return res.json();
  },
});
