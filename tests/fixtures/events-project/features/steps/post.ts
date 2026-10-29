import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the client posts to {path:string}",
  description: "POST to a path of the program, without following its redirect",
  args: z.object({ path: z.string() }),
  returns: z.object({ status: z.number() }),
  mutates: true,
  async run({ baseURL }, { path }) {
    const response = await fetch(new URL(path, baseURL), { method: "POST", redirect: "manual" });
    await response.text();
    return { status: response.status };
  },
});
