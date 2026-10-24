import { defineStep, z } from "nukadoko";
import createItem from "./create-item.ts";
import getItem from "./get-item.ts";
import getItemById from "./get-item-by-id.ts";
import listItems from "./list-items.ts";

export default defineStep({
  description: "The last response body's name is exactly this",
  pattern: "the response body has the name {name:string}",
  args: z.object({
    name: z.string().describe("The expected name"),
    body: z.unknown().describe("The body the last request got"),
  }),
  from: { body: [[createItem, "body"], [getItem, "body"], [getItemById, "body"], [listItems, "body"]] },
  claims: [{ actual: "body", at: "name", compare: "equal", expected: "name" }],
});
