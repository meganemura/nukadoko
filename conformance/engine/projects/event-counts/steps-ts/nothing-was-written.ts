import { defineStep, z } from "nukadoko";
import anItemIsAdded from "./an-item-is-added.ts";

export default defineStep({
  pattern: "nothing was written",
  description: "The item step wrote no row, as its execution events say",
  args: z.object({}),
  events: { writes: { of: anItemIsAdded, count: { kind: "db", op: ["insert", "update", "delete", "other"], committed: true } } },
  claims: [{ actual: "writes", compare: "equal", expected: { literal: 0 } }],
});
