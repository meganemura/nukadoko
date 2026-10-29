import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import post from "./post.js";

// A count of jobs: a parked job is enqueued and never performed, so the
// reading is not whole while the count of its enqueues is already one.
export default defineStep({
  pattern: "a recalculation was enqueued once",
  args: z.object({}),
  timeout: 1500,
  events: {
    enqueued: { of: post, count: { kind: "job", name: "ScoreRecalcJob", phase: "enqueue" } },
  },
  claims: [{ actual: "enqueued", compare: "equal", expected: { literal: 1 } }],
});
