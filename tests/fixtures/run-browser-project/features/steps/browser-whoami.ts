import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A claim step: navigates page to /whoami and reads back the Cookie header
// the server rendered into the page, proving this step's browser context is
// the *same* one browser-login.ts (a Background step) opened earlier in
// this same scenario. The page is read once, after goto waits for the load.
export default defineStep({
  pattern: "the browser sends the cookie {cookie:string}",
  description: "Read the Cookie header the server saw on this browser request",
  args: z.object({ cookie: z.string() }),
  async observe({ page, baseURL }) {
    await page.goto(`${baseURL}/whoami`);
    const text = await page.textContent("body");
    const body = JSON.parse(text ?? "null") as { cookie: string | null } | null;
    return { sent: body?.cookie ?? null };
  },
  poll: false,
  claims: [{ actual: "sent", compare: "contains-text", expected: "cookie" }],
});
