import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the agent adds the note {text:string} over stdio",
  description: "Call the add_note tool of a stdio MCP server that posts the note to the world",
  args: z.object({ text: z.string().describe("The note's text") }),
  returns: z.object({ reply: z.string().describe("The text the tool answered with") }),
  mutates: true,
  async run({ notesOverStdio }: any, { text }) {
    const answer = await notesOverStdio.callTool("add_note", { text });
    return { reply: answer.result.content[0].text as string };
  },
});
