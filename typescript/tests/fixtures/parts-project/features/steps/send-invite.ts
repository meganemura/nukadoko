import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The innermost part of a two-deep chain (docs/spec.md "Parts": "a part
// that calls a part nests the same way") — see invite-member.ts, which
// declares this as one of its own `parts`. No network, no fixtures beyond
// its own args: what this file proves is nesting, not evidence collection.
//
// `args.cc` and `returns.channel` both default and are both left unset by
// invite-member.ts/this file's own `run` — on purpose, so a CallEntry's
// `args` (raw, as the caller passed it) and `result` (returns-validated)
// are provably different objects rather than the same one twice: `args`
// must come back without `cc`, `result` must come back with `channel`. The
// return value's own type is asserted through `unknown` because `run`'s
// declared return type is `returns`' *validated* (default-applied) output
// shape, which this deliberately-incomplete literal does not itself match
// — the whole point being that `part.returns.safeParse` is what adds
// `channel` back, not this function.
const returns = z.object({ sent: z.boolean(), channel: z.string().default("email") });

export default defineStep({
  description: "Send an invite email and report whether it was sent",
  args: z.object({ email: z.string(), cc: z.string().default("none") }),
  returns,
  async run({}, args) {
    void args;
    return { sent: true } as unknown as z.infer<typeof returns>;
  },
});
