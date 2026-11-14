import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// tests/page-network.test.ts's own fixture —
// one step exercising both http.jsonl paths at once, against a real local
// server: `request` (the existing `via: "request"` path) and
// `page` navigating to a page that pulls in an image, a stylesheet,
// and a script (the new `via: "page"` path, and the asset types that get
// left out of http.jsonl and tallied into `http_omitted` instead), then an
// in-page `fetch` whose own query
// string carries a secret, the same redaction proof
// tests/trace-actions-step record.test.ts already runs for `actions[].url`.
// `source=request`/`source=page` on the shared `/api/data` path is what lets
// the test tell the two entries apart and confirm neither path double-counts
// the other's own call.
export default defineStep({
  pattern: "a page browses a page with assets and calls the api with a secret",
  description:
    "Call request once, then load a page with an image/stylesheet/script and make an in-page fetch carrying a secret (test fixture only)",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page, request, requireEnv }) {
    const token = requireEnv("API_TOKEN");

    await request.get("/api/data?source=request");

    await page.goto("/");
    await page.evaluate(async (t: string) => {
      await fetch(`/api/data?source=page&token=${t}`);
    }, token);

    return { ok: true };
  },
});
