import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Press the button",
  pattern: "the button is pressed",
  args: z.object({}),
  run() {
    return {};
  },
});
