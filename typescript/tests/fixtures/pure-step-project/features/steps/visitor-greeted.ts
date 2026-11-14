import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import visitorArrives from "./visitor-arrives.js";

// A claim step: it compares the name the arrival step returned with the
// name the line states, so the Then judges a value an earlier step produced.
export default defineStep({
  pattern: "the visitor {name:string} is greeted",
  description: "Checks that the visitor who arrived is the one the line names",
  args: z.object({ name: z.string(), arrived: z.string() }),
  from: { arrived: [visitorArrives, "name"] },
  claims: [{ actual: "arrived", compare: "equal", expected: "name" }],
});
