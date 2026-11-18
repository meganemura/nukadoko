import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Call a tool of a server that answers in the process, as a stdio server does",
  pattern: "the local MCP tool is called",
  args: z.object({}),
  mutates: false,
  async run({ local_notes }) {
    await local_notes.call("tools/call", { name: "add_note", arguments: { text: "milk" } });
  },
});
