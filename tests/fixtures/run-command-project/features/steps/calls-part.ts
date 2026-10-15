import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import commandPart from "./command-part.js";

export default defineStep({
  pattern: "a step calls a part that runs a command",
  description: "Calls a part whose body runs a command",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  parts: [commandPart],
  async run({ call }) {
    await call(commandPart, {});
    return { ok: true };
  },
});
