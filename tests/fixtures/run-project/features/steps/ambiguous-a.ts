import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Deliberately matches the exact same text as ambiguous-b.ts: `nuka check`
// would flag this vocabulary's "duplicate-pattern", but this fixture is for
// `nuka run` directly (no `check` run first), exercising its own run-time
// ambiguous-match rule (capture-binding-design.md: "実行時に1つのpickle step
// へ複数stepがマッチしたら両者を名指ししてrunエラー").
export default defineStep({
  pattern: "an ambiguous thing exists",
  description: "One of two steps that both match the same text",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
