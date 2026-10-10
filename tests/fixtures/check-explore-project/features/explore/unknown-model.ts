import { defineModel, defineStep, modelCommand, z } from "../../nukadoko-shim.js";

const ghost = defineStep({
  description: "not exported as the file's step",
  args: z.object({}),
  returns: z.object({}),
  run() {
    throw new Error("check ran a step");
  },
});

export default defineModel(() => {
  throw new Error("check called initial");
}).commands({
  "missing-step": modelCommand(ghost)({
    args: () => {
      throw new Error("check called args");
    },
    pre: () => {
      throw new Error("check called pre");
    },
    next: () => {
      throw new Error("check called next");
    },
    post: () => {
      throw new Error("check called post");
    },
  }),
});
