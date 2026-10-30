import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the agent adds the note {text:string} over stdio with the SDK client",
  description: "Call the add_note tool of a stdio MCP server that posts the note to the world, through the official SDK client",
  args: z.object({ text: z.string().describe("The note's text") }),
  returns: z.object({ reply: z.string().describe("The text the tool answered with") }),
  mutates: true,
  async run({ sdkOverStdio }: any, { text }) {
    const result = await sdkOverStdio.callTool({ name: "add_note", arguments: { text } });
    return { reply: result.content[0].text as string };
  },
});
