import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the notes include {text:string}",
  description: "GET /notes holds a note with this text",
  args: z.object({ text: z.string().describe("The note expected") }),
  async observe({ request }) {
    const res = await request.get("/notes");
    return { texts: ((await res.json()) as { text: string }[]).map((note) => note.text) };
  },
  claims: [{ actual: "texts", compare: "has-item", expected: "text" }],
});
