import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createWidget from "./create-widget.js";

// `from-unused` target: declares `from.id`, but its own pattern already
// captures `id` on the one line that binds it (features/notes.feature),
// so the declared producer never actually supplies anything. `nuka check`
// reports it as a note, not an error (nothing here is broken; `id` is
// always filled one way or another).
export default defineStep({
  pattern: "the widget {id:string} is inspected",
  description: "Inspect a widget by id",
  args: z.object({ id: z.string().describe("the widget's id") }),
  returns: z.object({ inspected: z.boolean().describe("always true") }),
  from: { id: [createWidget, "id"] },
  async run() {
    return { inspected: true };
  },
});
