import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import asksUnknownTool from "./asks-unknown-tool.js";

export default defineStep({
  pattern: "the server wrote nothing for it",
  args: z.object({}),
  timeout: 1500,
  events: { writes: { of: asksUnknownTool, count: { kind: "db", op: ["insert", "update", "delete", "other"], committed: true } } },
  claims: [{ actual: "writes", compare: "equal", expected: { literal: 0 } }],
});
