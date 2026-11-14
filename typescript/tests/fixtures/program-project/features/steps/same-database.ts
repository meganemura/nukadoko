import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import askProgram from "./ask-program.js";

export default defineStep({
  pattern: "the program and the step saw the same database",
  description: "The program's DB and the step's DB are one path",
  args: z.object({ db: z.string(), stepDb: z.string() }),
  from: { db: [askProgram, "db"], stepDb: [askProgram, "stepDb"] },
  claims: [{ actual: "db", compare: "equal", expected: { from: "stepDb" } }],
});
