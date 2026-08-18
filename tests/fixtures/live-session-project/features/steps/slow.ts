import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A deliberately slow step: tests/live-session.test.ts races a second
// `nuka do --session` call against this one's own `ms` to prove the "one
// execution at a time" refusal (docs/spec.md "Live sessions") without
// needing a browser or real network latency to create the window.
export default defineStep({
  description: "Wait `ms` milliseconds (default 300): slow on purpose, for racing a second call against",
  args: z.object({ ms: z.number().optional() }),
  returns: z.object({ waited_ms: z.number() }),
  mutates: false,
  async run({}, args) {
    const ms = args.ms ?? 300;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { waited_ms: ms };
  },
});
