import { z } from "zod";
import { defineStep } from "nukadoko";

// Separate from checked-thing.ts on purpose: passing.feature (stage 1's own
// scenario) must keep binding to a step whose record carries no
// sections/polls, so its "one result file per executed step" count stays
// exactly what it already is. This step exists only for mixed.feature, for
// the stage 2 child-step-nesting check: its own section/poll calls give
// the Allure emitter's child-step timeline something to merge, so a browser
// looking at this step's own test result finds a "section:"-named and a
// "poll:"-named child step nested one level under it, not two (docs/spec.md
// "Allure emitter": sections/polls/actions "nested directly under that
// step's own test, one level shallower than before").
export default defineStep({
  pattern: "the thing {name:string} exists after a section and a poll",
  description: "Check a thing exists, recording a section and a poll along the way",
  args: z.object({ name: z.string() }),
  returns: z.object({ found: z.boolean() }),
  mutates: false,
  async run({ section, poll }) {
    section("section: looked the thing up");
    await poll(async () => true, { description: "poll: waited for the lookup", interval: 5, timeout: 200 });
    return { found: true };
  },
});
