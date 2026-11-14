import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import listItems from "./list-items.js";

// The Then of from-dir.feature: a claim on the items list-items returned,
// whichever location-clause variant bound it.
export default defineStep({
  pattern: "the item {item:string} is listed",
  description: "Check that the listed items hold the one the line names",
  args: z.object({ item: z.string(), listed: z.array(z.string()) }),
  from: { listed: [listItems, "items"] },
  claims: [{ actual: "listed", compare: "has-item", expected: "item" }],
});
