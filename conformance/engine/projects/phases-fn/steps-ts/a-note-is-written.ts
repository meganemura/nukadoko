import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Write a note, the one change this program takes",
  pattern: "a note is written",
  args: z.object({}),
  run() {
    return {};
  },
});
