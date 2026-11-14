import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the agent adds the note {text:string} over HTTP with the SDK client",
  description: "Call the add_note tool of the world's MCP server over HTTP through the official SDK client",
  args: z.object({ text: z.string().describe("The note's text") }),
  returns: z.object({ reply: z.string().describe("The text the tool answered with") }),
  mutates: true,
  async run({ sdkOverHttp }: any, { text }) {
    const result = await sdkOverHttp.callTool({ name: "add_note", arguments: { text } });
    return { reply: result.content[0].text as string };
  },
});
