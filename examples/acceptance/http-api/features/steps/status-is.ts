import { defineStep, z } from "nukadoko";
import createItem from "./create-item.ts";
import getItem from "./get-item.ts";
import getItemById from "./get-item-by-id.ts";
import listItems from "./list-items.ts";

export default defineStep({
  description: "The last response's HTTP status is exactly this",
  pattern: "the response status is {expected:int}",
  args: z.object({
    expected: z.number().describe("The expected HTTP status"),
    status: z.number().describe("The status the last request got"),
  }),
  from: { status: [[createItem, "status"], [getItem, "status"], [getItemById, "status"], [listItems, "status"]] },
  claims: [{ actual: "status", compare: "equal", expected: "expected" }],
});
