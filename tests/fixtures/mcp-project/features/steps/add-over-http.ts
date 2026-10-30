import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the agent adds the note {text:string} over HTTP",
  description: "Call the add_note tool of the world's MCP server over HTTP",
  args: z.object({ text: z.string().describe("The note's text") }),
  returns: z.object({ reply: z.string().describe("The text the tool answered with") }),
  mutates: true,
  async run({ notesOverHttp }: any, { text }) {
    const answer = await notesOverHttp.callTool("add_note", { text });
    return { reply: answer.result.content[0].text as string };
  },
});
