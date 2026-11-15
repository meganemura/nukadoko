import { defineStep, z } from "nukadoko";
import { nuka, type Ran } from "./lib/engine.ts";
import { started } from "./lib/started.ts";
import theProject from "./the-project.ts";

// Starts a nuka that keeps running while later steps run, such as a
// `nuka run --step` that waits at its pauses for `nuka step`. The process
// is the project's: the step that reads how it ended waits for it.
export default defineStep({
  description: "Start this world's engine's nuka with these arguments in the project an earlier step built, without waiting for it to end",
  pattern: "nuka starts {argv:string}",
  args: z.object({
    argv: z.string().describe("Arguments after `nuka`, split on spaces"),
    dir: theProject.returns.shape.dir,
  }),
  from: { dir: [theProject, "dir"] },
  returns: z.object({
    started: z.string().describe("The project the started nuka runs in, which names it to the step that waits for it"),
  }),
  // nuka writes its run directory inside the scratch project only.
  mutates: false,
  run({}, { argv, dir }) {
    const ran: Promise<Ran> = nuka(
      dir,
      argv.split(" ").filter((word) => word !== ""),
      60_000,
    );
    // Read by the step that waits for it; a scenario that fails first
    // never waits, and the timeout ends the process.
    ran.catch(() => undefined);
    started.set(dir, ran);
    return { started: dir };
  },
});
