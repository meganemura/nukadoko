import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Add a task of a priority",
  pattern: "優先度{priority:priority}のタスクを足す",
  args: z.object({ priority: z.enum(["high", "low"]).describe("The priority the line gives") }),
  returns: z.object({ priority: z.enum(["high", "low"]).describe("The priority of the task") }),
  // Keeps nothing.
  mutates: false,
  run({}, { priority }) {
    return { priority };
  },
});
