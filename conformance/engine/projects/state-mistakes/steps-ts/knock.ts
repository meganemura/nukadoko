import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Someone knocks",
  pattern: "someone knocks",
  args: z.object({}),
  // @ts-expect-error a key args does not declare
  requires: [["inside", "door"]],
  mutates: false,
  run() {},
});
