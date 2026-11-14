import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A When that sends the program nothing: its events can never be whole,
// since no line can say that it caused no work.
export default defineStep({
  pattern: "the client does nothing",
  description: "send the program no request",
  args: z.object({}),
  mutates: false,
  run() {},
});
