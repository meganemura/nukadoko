import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

const inlet = z.object({ file: z.string().nullable(), fileMode: z.number().nullable(), dirMode: z.number().nullable(), named: z.array(z.string()) });

// Sends nothing for long enough that a line an earlier step's request
// writes late arrives while it runs, then asks the program where its
// events file is, and which of its variables name one.
export default defineStep({
  pattern: "the step waits",
  description: "wait 900 ms, then ask the program where its events file is",
  args: z.object({}),
  returns: inlet,
  mutates: false,
  async run({ baseURL }) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    const response = await fetch(new URL("/inlet", baseURL));
    return inlet.parse(await response.json());
  },
});
