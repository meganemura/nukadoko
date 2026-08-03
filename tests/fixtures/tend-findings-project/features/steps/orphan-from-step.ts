import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createWidget from "./create-widget.js";

// `from-unused` target: declares `from.id`, but its own pattern already
// captures `id` on the one line that binds it (features/tending.feature),
// so the declared producer never actually supplies anything — `nuka tend`
// should report this, not `nuka check` (nothing here is broken; `id` is
// always filled one way or another).
export default defineStep({
  pattern: "the widget {id:string} is inspected",
  description: "Inspect a widget by id",
  rationale: "id is read straight off the line; from exists only as a do --use fallback, which is the point of this fixture",
  args: z.object({ id: z.string().describe("the widget's id") }),
  returns: z.object({ inspected: z.boolean().describe("always true") }),
  from: { id: [createWidget, "id"] },
  async run() {
    return { inspected: true };
  },
});
