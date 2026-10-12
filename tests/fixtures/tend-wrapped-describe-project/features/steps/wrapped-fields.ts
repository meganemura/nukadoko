import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Every field is described on the inner schema and then wrapped, except
// `bare`, the control that must stay reported.
export default defineStep({
  description: "Return the same described value under every wrapper",
  rationale: "CLI-only vocabulary; target for schema-field-undescribed under wrappers",
  args: z.object({}),
  returns: z.object({
    optional_: z.string().describe("x").optional(),
    default_: z.string().describe("x").default("x"),
    nullable: z.string().describe("x").nullable(),
    nullish: z.string().describe("x").nullish(),
    readonly_: z.string().describe("x").readonly(),
    caught: z.string().describe("x").catch("x"),
    prefaulted: z.string().describe("x").prefault("x"),
    piped: z.string().describe("x").transform((value) => value.length),
    bare: z.string().nullable(),
  }),
  async run() {
    return {
      optional_: "x", default_: "x", nullable: "x", nullish: "x", readonly_: "x",
      caught: "x", prefaulted: "x", piped: 1, bare: null,
    };
  },
});
