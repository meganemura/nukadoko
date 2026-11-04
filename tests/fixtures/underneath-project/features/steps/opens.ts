import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the visitor opens {path:string}",
  description: "Open a page of the program in the browser",
  args: z.object({ path: z.string() }),
  returns: z.object({ title: z.string() }),
  mutates: false,
  async run({ page, baseURL }, { path }) {
    await page.goto(new URL(path, baseURL).href, { waitUntil: "load" });
    return { title: await page.title() };
  },
});
