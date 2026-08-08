import { z } from "zod";
import { defineStep } from "nukadoko";

// Exists only so selftest-suite/features/steps/allure-watch.ts's mid-run
// assertion has something to observe (selftest-watch task spec, decision
// 4). `allure watch` reflects a written result file 150-351ms after it
// lands and polls its own results directory every 300ms (both measured
// facts, not re-derived here); every other step in this fixture project
// runs in a few milliseconds, so a run of them writes every result file
// before watch's first poll ever fires -- the report jumps straight from 0
// to the final count in one paint, and there is nothing in between to
// observe. A ~2 second delay per step guarantees at least one poll cycle
// lands between two step completions, so the live report's own count
// visibly rises one step at a time while the run is still going. Do not
// speed this up or swap it for a faster step: that would turn the one test
// that proves updates arrive *incrementally* back into a test that only
// proves they arrive *eventually*, which selftest-suite's own stage 2
// (features/steps/allure-report.ts) already covers by reading a finished
// report.
export default defineStep({
  pattern: "a slow thing {name:string} exists",
  description: "Create a thing slowly, so a live-watched report has time to show it mid-run",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run({}, args) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { id: `slow_${args.name}`, name: args.name };
  },
});
