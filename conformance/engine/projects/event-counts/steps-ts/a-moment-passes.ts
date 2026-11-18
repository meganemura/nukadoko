import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Wait long enough for lines the program writes later to arrive",
  pattern: "a moment passes",
  args: z.object({}),
  returns: z.object({ waited: z.number().describe("The milliseconds waited") }),
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { waited: 600 };
  },
});
