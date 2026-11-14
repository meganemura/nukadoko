import { defineStep, z } from "nukadoko";
import createItem from "./create-item.ts";
import getItem from "./get-item.ts";
import getItemById from "./get-item-by-id.ts";
import listItems from "./list-items.ts";

export default defineStep({
  description: "The last response body, as JSON, deep-equals the docstring's JSON",
  pattern: "the response body is",
  args: z.object({
    expected: z.string().describe("The expected body as JSON text"),
    body: z.unknown().describe("The body the last request got"),
  }),
  from: { body: [[createItem, "body"], [getItem, "body"], [getItemById, "body"], [listItems, "body"]] },
  // The docstring is JSON text, and expected_view reads it as JSON, so the
  // claim compares two JSON values (key order does not count) and the
  // record keeps the docstring as the line stated it.
  claims: [{ actual: "body", compare: "equal", expected: "expected", expected_view: "json" }],
});
