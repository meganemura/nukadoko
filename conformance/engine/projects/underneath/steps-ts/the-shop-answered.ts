import { defineStep, z } from "nukadoko";
import theShopIsAskedAt from "./the-shop-is-asked-at.ts";

export default defineStep({
  pattern: "the shop answered {n:int} time",
  description: "The asking step was served this many requests, as the shop's execution events say",
  args: z.object({ n: z.number().int().describe("How many requests") }),
  events: { requests: { of: theShopIsAskedAt, count: { kind: "request" } } },
  claims: [{ actual: "requests", compare: "equal", expected: "n" }],
});
