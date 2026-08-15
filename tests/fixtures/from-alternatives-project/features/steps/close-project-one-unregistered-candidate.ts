import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// One candidate of a multi-candidate `from` key is a `Step` discovery never
// registered — the same "reached through a different `await import()`"
// mistake docs/spec.md "Chaining steps" describes, now checked per candidate
// instead of only ever being
// possible for a key's single candidate. `createProject` (the other
// candidate) is genuinely valid, so this fixture proves the structural check
// reports the broken candidate without silencing the sound one.
const neverDiscovered = defineStep({
  description: "not discovered on purpose — never exported as any file's default",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  run() {
    return { id: "phantom" };
  },
});

export default defineStep({
  description: "close-project with one registered and one unregistered candidate producer",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ closed: z.boolean() }),
  from: { projectId: [[createProject, "id"], [neverDiscovered, "id"]] },
  async run() {
    return { closed: true };
  },
});
