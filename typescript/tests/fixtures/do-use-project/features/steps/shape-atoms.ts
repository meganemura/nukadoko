import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import countAtoms from "./count-atoms.js";

export default defineStep({
  description: "Shape the atoms through pipes, codecs, and transforms (from count-atoms, or --use)",
  args: z.object({
    piped: z.string().pipe(z.coerce.bigint()),
    coded: z.codec(z.string(), z.bigint(), { decode: (text) => BigInt(text), encode: (big) => big.toString() }),
    stamped: z.codec(z.iso.datetime(), z.date(), { decode: (text) => new Date(text), encode: (date) => date.toISOString() }),
    doubled: z.bigint().transform((big) => big * 2n),
    epoch: z.date().transform((date) => date.getTime()),
  }),
  returns: z.object({ piped: z.bigint(), coded: z.bigint(), stamped: z.string(), doubled: z.bigint(), epoch: z.number() }),
  from: { piped: [countAtoms, "total"], coded: [countAtoms, "total"], doubled: [countAtoms, "total"] },
  async run({}, args) {
    return { ...args, stamped: args.stamped.toISOString() };
  },
});
