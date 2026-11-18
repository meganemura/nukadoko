import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Use the tenant fixture and fail",
  pattern: "the tenant breaks",
  args: z.object({}),
  mutates: false,
  async run({ tenant }) {
    void tenant;
    throw new Error("the tenant broke");
  },
});
