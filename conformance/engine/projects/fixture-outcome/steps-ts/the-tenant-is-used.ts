import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Use the tenant fixture and nothing else",
  pattern: "the tenant is used",
  args: z.object({}),
  mutates: false,
  async run({ tenant }) {
    void tenant;
  },
});
