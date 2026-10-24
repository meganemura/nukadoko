import { defineStep, z } from "nukadoko";
import createItem from "./create-item.ts";
import getItem from "./get-item.ts";
import getItemById from "./get-item-by-id.ts";
import listItems from "./list-items.ts";

export default defineStep({
  description: "The last response body, as JSON, deep-equals the docstring's JSON",
  pattern: "the response body is",
  args: z.object({
    // The docstring is JSON text; args parses it, so the claim compares two
    // JSON values and key order does not count.
    expected: z
      .string()
      .describe("The expected body as JSON text")
      .transform((text): unknown => JSON.parse(text)),
    body: z.unknown().describe("The body the last request got"),
  }),
  from: { body: [[createItem, "body"], [getItem, "body"], [getItemById, "body"], [listItems, "body"]] },
  claims: [{ actual: "body", compare: "equal", expected: "expected" }],
});
