import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the client puts to {path:string}",
  description: "PUT to a path of the program",
  args: z.object({ path: z.string() }),
  returns: z.object({ status: z.number() }),
  mutates: true,
  async run({ baseURL }, { path }) {
    const response = await fetch(new URL(path, baseURL), { method: "PUT" });
    await response.text();
    return { status: response.status };
  },
});
