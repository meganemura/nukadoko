import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Send the notes server the notification that the client is ready",
  pattern: "the MCP client says it is ready",
  args: z.object({}),
  mutates: false,
  async run({ notes }) {
    await notes.notify("notifications/initialized");
  },
});
