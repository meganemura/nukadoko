import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Return a key with no returns declared",
  pattern: "a key is kept",
  args: z.object({}),
  mutates: false,
  run() {
    return { extra: 1 } as never;
  },
});
