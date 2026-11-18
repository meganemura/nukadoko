import { defineStep, z } from "nukadoko";
import anItemIsListed from "./an-item-is-listed.ts";

export default defineStep({
  pattern: "the list was requested {n:int} time",
  description: "The list step sent this many requests, as its execution events say",
  args: z.object({ n: z.number().int().describe("How many requests") }),
  events: { requests: { of: anItemIsListed, count: { kind: "request" } } },
  claims: [{ actual: "requests", compare: "equal", expected: "n" }],
});
