import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// No allure facade call, no World channel at all — proves the receipt's own
// `declared` field is omitted entirely when nothing was ever recorded (this
// task's spec, test list's last bullet).
export default defineStep({
  pattern: "a plain step runs with no declared data",
  description: "A step that never calls the allure facade or a World channel",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
