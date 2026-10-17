import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
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
  mutates: false,
  returns: z.object({ body: z.unknown().describe("The body actually received") }),
  run({}, { expected, body }) {
    assert.deepEqual(body, JSON.parse(expected), `body: expected ${expected.trim()}, got ${JSON.stringify(body)}`);
    return { body };
  },
});
