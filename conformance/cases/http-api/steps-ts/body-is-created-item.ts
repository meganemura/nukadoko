import { defineStep, z } from "nukadoko";
import anItemExists from "./an-item-exists.ts";
import getItem from "./get-item.ts";

export default defineStep({
  description: "The last response body is the item an earlier step created, id and name",
  pattern: "the response body is the item that was created",
  args: z.object({
    body: z.unknown().describe("The body the read got"),
    created: anItemExists.returns.shape.body,
  }),
  from: { body: [getItem, "body"], created: [anItemExists, "body"] },
  claims: [{ actual: "body", compare: "equal", expected: { from: "created" } }],
});
