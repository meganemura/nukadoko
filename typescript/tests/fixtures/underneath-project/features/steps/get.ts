import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the client gets {path:string}",
  description: "GET a path of the program",
  args: z.object({ path: z.string() }),
  returns: z.object({ status: z.number() }),
  mutates: false,
  async run({ baseURL }, { path }) {
    const response = await fetch(new URL(path, baseURL));
    await response.text();
    return { status: response.status };
  },
});
