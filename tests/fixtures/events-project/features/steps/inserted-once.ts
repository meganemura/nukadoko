import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import post from "./post.js";

export default defineStep({
  pattern: "the score row was inserted once",
  args: z.object({}),
  timeout: 1500,
  events: {
    inserts: { of: post, count: { kind: "db", table: "scores", op: "insert", committed: true } },
  },
  claims: [{ actual: "inserts", compare: "equal", expected: { literal: 1 } }],
});
