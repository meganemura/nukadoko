import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a note {text:string} is added with a token",
  description: "POST /notes with plain fetch, sending a secret in the body",
  args: z.object({ text: z.string().describe("The note") }),
  mutates: true,
  async run({ baseURL, requireEnv }, args) {
    const token = requireEnv("NOTE_TOKEN");
    // In the query too: a secret can land in a URL as easily as in a body.
    await fetch(new URL(`/notes?key=${token}`, baseURL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: args.text, token }),
    });
  },
});
