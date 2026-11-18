import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Call a method the notes server does not know over MCP",
  pattern: "an unknown MCP method is called",
  args: z.object({}),
  mutates: false,
  async run({ notes }) {
    await notes.call("notes/nope");
  },
});
