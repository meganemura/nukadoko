import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the agent calls a tool the server does not have",
  description: "Call a tool name the world's MCP server answers with a JSON-RPC error",
  args: z.object({}),
  returns: z.object({ code: z.number().describe("The JSON-RPC error code") }),
  mutates: false,
  async run({ notesOverHttp }: any) {
    const answer = await notesOverHttp.callTool("remove_note", { id: 1 });
    return { code: answer.error.code as number };
  },
});
