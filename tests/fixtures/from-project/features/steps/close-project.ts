import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// Exercises `from` and `ctx.resultOf` reading the *same* upstream step in
// one execution (m6a-from-core task spec, acceptance test: both paths
// writing into the same `used` collector still dedupe by record id) —
// `from` fills `projectId` (a key name), and `run()` separately calls
// `ctx.resultOf` for the project's `name`, a value `from`'s key-name shape
// alone can't express without adding a second args key just to carry it.
export default defineStep({
  pattern: "the project is closed",
  description:
    "Close the project created earlier in this scenario, reading its id via from and its name via ctx.resultOf",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ closed: z.boolean(), projectId: z.string(), projectName: z.string().nullable() }),
  from: { projectId: [createProject, "id"] },
  async run({ resultOf }, args) {
    const project = resultOf(createProject);
    return { closed: true, projectId: args.projectId, projectName: project?.name ?? null };
  },
});
