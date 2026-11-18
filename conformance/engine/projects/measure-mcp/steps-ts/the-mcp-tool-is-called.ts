import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Call a tool of the notes server over MCP",
  pattern: "the MCP tool {tool:string} is called",
  args: z.object({ tool: z.string().describe("The tool's name") }),
  returns: z.object({ text: z.string().describe("The text of the tool's answer") }),
  mutates: false,
  async run({ notes }, { tool }) {
    const answer = (await notes.call("tools/call", { name: tool, arguments: { text: "milk" } })) as { result: { content: { text: string }[] } };
    return { text: answer.result.content[0]!.text };
  },
});
