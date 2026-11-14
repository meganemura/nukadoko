import { defineStep, z } from "nukadoko";
import createItem from "./create-item.ts";
import getItem from "./get-item.ts";
import getItemById from "./get-item-by-id.ts";
import listItems from "./list-items.ts";

export default defineStep({
  description: "The last response body holds an id the API assigned",
  pattern: "the response body has an id of at least 1",
  args: z.object({ body: z.unknown().describe("The body the last request got") }),
  from: { body: [[createItem, "body"], [getItem, "body"], [getItemById, "body"], [listItems, "body"]] },
  claims: [{ actual: "body", at: "id", compare: "at-least", expected: { literal: 1 } }],
});
