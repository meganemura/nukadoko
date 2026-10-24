import http from "node:http";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the step calls the program through node:http",
  description: "GET /node through node:http",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ baseURL }) {
    await new Promise<void>((resolve, reject) => {
      http.get(new URL("/node", baseURL), (res) => res.resume().on("end", resolve)).on("error", reject);
    });
    return {};
  },
});
