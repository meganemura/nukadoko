import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A pattern whose capture never closes",
  pattern: "I start {n:int",
  args: z.object({}),
  run() {
    return {};
  },
});
