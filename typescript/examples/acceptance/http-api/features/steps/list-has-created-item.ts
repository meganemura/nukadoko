import { defineStep, z } from "nukadoko";
import anItemExists from "./an-item-exists.ts";
import listItems from "./list-items.ts";

// Other scenarios share the server, so the list holds their items too; the
// claim is that this scenario's item is among them.
export default defineStep({
  description: "The item list holds the item an earlier step created, id and name",
  pattern: "the list has the item that was created",
  args: z.object({
    body: z.unknown().describe("The list the request got"),
    created: anItemExists.returns.shape.body,
  }),
  from: { body: [listItems, "body"], created: [anItemExists, "body"] },
  claims: [{ actual: "body", compare: "has-item", expected: { from: "created" } }],
});
